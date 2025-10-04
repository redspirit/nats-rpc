import { connect, JSONCodec } from 'nats';

const jc = JSONCodec();

export class NATS {
    constructor(connectionConfig = {}, opts = {}) {
        this.connectionConfig = connectionConfig;
        this.defaultTimeout = opts.defaultTimeout ?? 10000;
        this.nc = null;
        this.js = null;
        this._subs = new Set();
    }

    async connect() {
        if (this.nc) return this.nc;
        this.nc = await connect(this.connectionConfig);
        this.nc.closed().then((err) => {
            if (err) console.error('NATS connection closed with error:', err);
            else console.info('NATS connection closed.');
        });
        return this.nc;
    }

    async service(name, handlers = {}, serviceOpts = {}) {
        await this.connect();
        for (const [method, handler] of Object.entries(handlers)) {
            const subject = `${name}.${method}`;
            const queue = serviceOpts.queue ?? name;
            const sub = this.nc.subscribe(subject, { queue });
            this._subs.add(sub);

            (async (s, h, subj) => {
                console.log(`Service listening: ${subj} (queue=${queue})`);
                try {
                    for await (const m of s) {
                        let payload;
                        try {
                            payload = m.data && m.data.length ? jc.decode(m.data) : undefined;
                        } catch (err) {
                            if (m.respond)
                                m.respond(
                                    jc.encode({
                                        __error: true,
                                        message: 'invalid JSON payload',
                                        stack: err?.message,
                                    })
                                );
                            continue;
                        }
                        try {
                            const result = await h(payload, m);
                            if (m.respond) m.respond(jc.encode({ __ok: true, result }));
                        } catch (err) {
                            const remoteErr = {
                                __error: true,
                                message: err?.message ?? String(err),
                                stack: err?.stack,
                                name: err?.name,
                            };
                            if (m.respond) {
                                try {
                                    m.respond(jc.encode(remoteErr));
                                } catch (_) {
                                    console.error('Respond failed:', _);
                                }
                            } else
                                console.error(`Service handler error (no reply) for ${subj}:`, err);
                        }
                    }
                } catch (err) {
                    console.warn(`Subscription for ${subj} closed:`, err?.message ?? err);
                } finally {
                    this._subs.delete(s);
                }
            })(sub, handler, subject).catch((e) =>
                console.error('service handler launcher error:', e)
            );
        }
    }

    /**
     * RPC call with optional retries on NO_RESPONDERS.
     *
     * options:
     *  - timeout: number (ms) - overrides defaultTimeout
     *  - retries: number - how many times to retry after initial attempt (default 3)
     *  - retryDelay: number - base delay in ms for backoff (default 1000)
     *  - maxRetryDelay: number - maximum delay in ms (default 2000)
     *  - skipFlush: passthrough for publish (not used here)
     */
    async call(subject, data = undefined, options = {}) {
        await this.connect();
        const timeout = typeof options.timeout === 'number' ? options.timeout : this.defaultTimeout;
        const retries = Number.isInteger(options.retries) ? options.retries : 3; // number of retries after the first attempt
        const retryDelay = typeof options.retryDelay === 'number' ? options.retryDelay : 1000;
        const maxRetryDelay =
            typeof options.maxRetryDelay === 'number' ? options.maxRetryDelay : 20000;

        let attempt = 0; // number of retries already performed

        const isNoResponders = (err) => {
            const errMsg = String(err?.message ?? '');
            const errCodeStr = String(err?.code ?? '');
            return (
                err?.code === 'NO_RESPONDERS' ||
                errCodeStr === 'NO_RESPONDERS' ||
                errCodeStr === '503' ||
                /\bno responders\b/i.test(errMsg) ||
                /\b503\b/.test(errMsg)
            );
        };

        while (true) {
            try {
                const msg = await this.nc.request(subject, jc.encode(data), { timeout });
                const resp = msg.data && msg.data.length ? jc.decode(msg.data) : undefined;
                if (!resp) return resp;
                if (resp.__error) {
                    const e = new Error(resp.message ?? 'remote error');
                    e.code = 'RPC_REMOTE_ERROR';
                    e.remoteStack = resp.stack;
                    e.remoteName = resp.name;
                    throw e;
                }
                if (resp.__ok) return resp.result;
                return resp;
            } catch (err) {
                const errMsg = String(err?.message ?? '');
                if (err?.code === 'REQ_TIMEOUT' || /\btimeout\b/i.test(errMsg)) {
                    const e = new Error(`RPC timeout after ${timeout}ms for subject ${subject}`);
                    e.code = 'RPC_TIMEOUT';
                    e.timeout = timeout;
                    throw e;
                }

                if (isNoResponders(err)) {
                    if (attempt < retries) {
                        // exponential backoff with small jitter
                        const base = Math.min(maxRetryDelay, retryDelay * Math.pow(2, attempt));
                        const jitter = Math.floor(Math.random() * Math.min(100, base * 0.1));
                        const wait = base + jitter;
                        console.warn(
                            `No responders for ${subject} (attempt ${
                                attempt + 1
                            }/${retries}). Retrying in ${wait}ms...`
                        );
                        await new Promise((r) => setTimeout(r, wait));
                        attempt += 1;
                        continue; // retry
                    }
                    const e = new Error(`No responders for subject ${subject}`);
                    e.code = 'RPC_NO_RESPONDERS';
                    throw e;
                }

                // any other error
                throw err;
            }
        }
    }

    async on(subject, handler, opts = {}) {
        await this.connect();
        const sub = this.nc.subscribe(subject, opts);
        this._subs.add(sub);

        (async (s, h, subj) => {
            try {
                for await (const m of s) {
                    let payload;
                    try {
                        payload = m.data && m.data.length ? jc.decode(m.data) : undefined;
                    } catch (err) {
                        console.error(`Failed to decode message on ${m.subject}:`, err.message);
                        continue;
                    }
                    try {
                        await h(payload, m);
                    } catch (err) {
                        console.error(`Handler for ${subj} failed:`, err);
                    }
                }
            } catch (err) {
                console.warn(`Subscription for ${subj} closed:`, err?.message ?? err);
            } finally {
                this._subs.delete(s);
            }
        })(sub, handler, subject).catch((e) => console.error('subscription launcher error:', e));

        return {
            subj: subject,
            sub,
            unsubscribe: async () => {
                try {
                    await sub.drain();
                } catch (e) {
                    try {
                        sub.unsubscribe();
                    } catch (_) {}
                }
            },
        };
    }

    async emit(subject, data = undefined, options = {}) {
        await this.connect();
        const { skipFlush, ...publishOpts } = options;
        try {
            this.nc.publish(subject, jc.encode(data ?? null), publishOpts);
            if (!skipFlush) await this.nc.flush();
        } catch (err) {
            console.warn('NATS publish/flush error:', err?.message ?? err);
            throw err;
        }
    }

    async drain() {
        if (!this.nc) return;
        try {
            await this.nc.drain();
        } catch (err) {
            console.warn('Error while draining NATS connection:', err?.message ?? err);
            try {
                await this.nc.close();
            } catch (_) {}
        } finally {
            this.nc = null;
        }
    }

    async close() {
        if (!this.nc) return;
        try {
            await this.nc.close();
        } catch (err) {
            console.warn('Error closing NATS connection:', err?.message ?? err);
        } finally {
            this.nc = null;
        }
    }
}

export default NATS;
