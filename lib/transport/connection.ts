import * as Control from "./control"
import { Objects } from "./object"
import { asError } from "../common/error"

import { Publisher } from "./publisher"
import { Subscriber } from "./subscriber"

export class Connection {
	// The established WebTransport session.
	#quic: WebTransport

	// Use to receive/send control messages.
	#control: Control.Stream

	// Use to receive/send objects.
	#objects: Objects

	// Module for contributing tracks.
	#publisher: Publisher

	// Module for distributing tracks.
	#subscriber: Subscriber

	// Async work running in the background
	#running: Promise<void>

	constructor(quic: WebTransport, control: Control.Stream, objects: Objects) {
		this.#quic = quic
		this.#control = control
		this.#objects = objects

		this.#publisher = new Publisher(this.#control, this.#objects)
		this.#subscriber = new Subscriber(this.#control, this.#objects)

		this.#running = this.#run()
	}

	close(code = 0, reason = "") {
		this.#quic.close({ closeCode: code, reason })
	}

	async #run(): Promise<void> {
		await Promise.all([this.#runControl(), this.#runObjects()])
	}

	announce(namespace: string) {
		return this.#publisher.announce(namespace)
	}

	announced() {
		return this.#subscriber.announced()
	}

	subscribe(namespace: string, track: string) {
		return this.#subscriber.subscribe(namespace, track)
	}

	subscribed() {
		return this.#publisher.subscribed()
	}

	async #runControl() {
		// Receive messages until the connection is closed.
		for (;;) {
			const msg = await this.#control.recv()
			await this.#recv(msg)
		}
	}

	async #runObjects() {
		for (;;) {
			const obj = await this.#objects.recv()
			if (!obj) break

			await this.#subscriber.recvObject(obj.header, obj.stream)
		}
	}

	async #recv(msg: Control.Message) {
		switch (msg.kind) {
			case Control.Msg.Announce:
				return this.#subscriber.recvAnnounce(msg)
			case Control.Msg.AnnounceOk:
				return this.#publisher.recvAnnounceOk(msg)
			case Control.Msg.AnnounceReset:
				return this.#publisher.recvAnnounceReset(msg)
			case Control.Msg.Subscribe:
				return this.#publisher.recvSubscribe(msg)
			case Control.Msg.SubscribeOk:
				return this.#subscriber.recvSubscribeOk(msg)
			case Control.Msg.SubscribeReset:
				return this.#subscriber.recvSubscribeReset(msg)
		}
	}

	async closed(): Promise<Error> {
		try {
			await this.#running
			return new Error("closed")
		} catch (e) {
			return asError(e)
		}
	}
}
