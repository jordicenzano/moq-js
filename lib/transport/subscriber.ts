import * as Control from "./control"
import { Queue, Watch } from "../common/async"
import { Header, Objects } from "./object"

export class Subscriber {
	// Use to send control messages.
	#control: Control.Stream

	// Use to send objects.
	#objects: Objects

	// Announced broadcasts.
	#announce = new Map<string, AnnounceRecv>()
	#announceQueue = new Watch<AnnounceRecv[]>([])

	// Our subscribed tracks.
	#subscribe = new Map<bigint, SubscribeSend>()
	#subscribeNext = 0n

	constructor(control: Control.Stream, objects: Objects) {
		this.#control = control
		this.#objects = objects
	}

	announced(): Watch<AnnounceRecv[]> {
		return this.#announceQueue
	}

	async recvAnnounce(msg: Control.Announce) {
		if (this.#announce.has(msg.namespace)) {
			throw new Error(`duplicate announce for namespace: ${msg.namespace}`)
		}

		await this.#control.send({ kind: Control.Msg.AnnounceOk, namespace: msg.namespace })

		const announce = new AnnounceRecv(this.#control, msg.namespace)
		this.#announce.set(msg.namespace, announce)

		this.#announceQueue.update((queue) => [...queue, announce])
	}

	async subscribe(namespace: string, track: string) {
		const id = this.#subscribeNext++

		const subscribe = new SubscribeSend(this.#control, id, namespace, track)
		this.#subscribe.set(id, subscribe)

		await this.#control.send({
			kind: Control.Msg.Subscribe,
			id,
			namespace,
			name: track,
		})

		return subscribe
	}

	recvSubscribeOk(msg: Control.SubscribeOk) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe ok for unknown id: ${msg.id}`)
		}

		subscribe.onOk()
	}

	async recvSubscribeReset(msg: Control.SubscribeReset) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe error for unknown id: ${msg.id}`)
		}

		await subscribe.onError(msg.code, msg.reason)
	}

	async recvObject(header: Header, stream: ReadableStream<Uint8Array>) {
		const subscribe = this.#subscribe.get(header.track)
		if (!subscribe) {
			throw new Error(`data for for unknown track: ${header.track}`)
		} else {
			await subscribe.onData(header, stream)
		}
	}
}

export class AnnounceRecv {
	#control: Control.Stream

	readonly namespace: string

	// The current state of the announce
	#state: "init" | "ack" | "closed" = "init"

	constructor(control: Control.Stream, namespace: string) {
		this.#control = control // so we can send messages
		this.namespace = namespace
	}

	// Acknowledge the subscription as valid.
	async ok() {
		if (this.#state !== "init") return
		this.#state = "ack"

		// Send the control message.
		return this.#control.send({ kind: Control.Msg.AnnounceOk, namespace: this.namespace })
	}

	async close(code = 0n, reason = "") {
		if (this.#state === "closed") return
		this.#state = "closed"

		return this.#control.send({ kind: Control.Msg.AnnounceReset, namespace: this.namespace, code, reason })
	}
}

export class SubscribeSend {
	#control: Control.Stream
	#id: bigint

	readonly namespace: string
	readonly track: string

	// A queue of received streams for this subscription.
	#data = new Queue<{ header: Header; stream: ReadableStream<Uint8Array> }>()

	constructor(control: Control.Stream, id: bigint, namespace: string, track: string) {
		this.#control = control // so we can send messages
		this.#id = id
		this.namespace = namespace
		this.track = track
	}

	async close(_code = 0n, _reason = "") {
		// TODO implement unsubscribe
		// await this.#inner.sendReset(code, reason)
	}

	onOk() {
		// noop
	}

	async onError(code: bigint, reason: string) {
		if (code == 0n) {
			return await this.#data.close()
		}

		if (reason !== "") {
			reason = `: ${reason}`
		}

		const err = new Error(`SUBSCRIBE_ERROR (${code})${reason}`)
		return await this.#data.abort(err)
	}

	async onData(header: Header, stream: ReadableStream<Uint8Array>) {
		if (!this.#data.closed()) await this.#data.push({ header, stream })
	}

	// Receive the next a readable data stream
	async data() {
		return this.#data.next()
	}
}
