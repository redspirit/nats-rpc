import { connect, StringCodec } from 'nats';

const sc = StringCodec();

export class RPC {
    constructor(serviceName = null, url = 'nats://localhost:4222') {
        this.serviceName = serviceName;
        this.url = url;
        this.nc = null;
    }

    async connect() {
        if (!this.nc) {
            this.nc = await connect({ servers: this.url });
            console.log(`[${this.serviceName || 'client'}] connected to ${this.url}`);
        }
        return this.nc;
    }

    _subject(name) {
        return this.serviceName ? `${this.serviceName}.${name}` : name;
    }

    // RPC-метод
    async method(name, handler) {
        const subject = this._subject(name);
        const nc = await this.connect();
        const sub = nc.subscribe(subject);

        (async () => {
            for await (const m of sub) {
                try {
                    const data = JSON.parse(sc.decode(m.data));
                    const result = await handler(data);
                    m.respond(sc.encode(JSON.stringify({ result })));
                } catch (err) {
                    m.respond(sc.encode(JSON.stringify({ error: err.message })));
                }
            }
        })();

        console.log(`Method registered: ${subject}`);
    }

    // Вызов RPC
    async call(name, data, timeout = 1000) {
        const subject = this._subject(name);
        const nc = await this.connect();
        const msg = await nc.request(subject, sc.encode(JSON.stringify(data)), {
            timeout,
        });
        const res = JSON.parse(sc.decode(msg.data));
        if (res.error) throw new Error(res.error);
        return res.result;
    }

    // Fire-and-forget событие
    async emit(event, data) {
        const subject = this._subject(event);
        const nc = await this.connect();
        nc.publish(subject, sc.encode(JSON.stringify(data)));
    }

    // Подписка на событие
    async on(event, handler, queueGroup = null) {
        const subject = this._subject(event);
        const nc = await this.connect();
        const sub = nc.subscribe(subject, { queue: queueGroup });

        (async () => {
            for await (const m of sub) {
                try {
                    const data = JSON.parse(sc.decode(m.data));
                    await handler(data);
                } catch (err) {
                    console.error('Event handler error:', err);
                }
            }
        })();

        console.log(`Subscribed to event: ${subject}`);
    }
}
