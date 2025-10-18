import { connect, JSONCodec } from 'nats';

const jc = JSONCodec();

export class NATS {
    constructor(connectionConfig = {}, opts = {}) {
        this.connectionConfig = connectionConfig;
        this.defaultTimeout = opts.defaultTimeout ?? 10000;
        this.nc = null;
        this.js = null;
        this._subs = new Set();

        // internal flags
        this._statusWatcherStarted = false;
        this._statusWatcherPromise = null;
    }

    async connect() {
        if (this.nc) return this.nc;
        this.nc = await connect(this.connectionConfig);

        // closed() promise for final close
        this.nc.closed().then((err) => {
            if (err) console.error('NATS connection closed with error:', err);
            else console.info('NATS connection closed.');
        });

        // Start a single status monitor to log reconnect/disconnect events.
        if (!this._statusWatcherStarted) {
            this._statusWatcherStarted = true;
            this._statusWatcherPromise = (async () => {
                try {
                    // status() is an async iterator that yields status updates
                    for await (const s of this.nc.status()) {
                        // Try to inspect common fields safely; fallback to stringified object
                        let info;
                        try {
                            if (typeof s === 'string') info = s;
                            else if (s && typeof s === 'object' && (s.type || s.kind || s.status))
                                info = s.type ?? s.kind ?? s.status;
                            else info = JSON.stringify(s);
                        } catch (e) {
                            info = String(s);
                        }

                        // We only log important events at info/warn level
                        const low = String(info).toLowerCase();
                        if (/\b(reconnect|reconnected|reconnecting)\b/.test(low)) {
                            console.info(`NATS reconnect status: ${info}`);
                        } else if (/\b(disconnect|disconnected|disconnecting)\b/.test(low)) {
                            console.warn(`NATS disconnect status: ${info}`);
                        } else if (/\b(connected|connect)\b/.test(low)) {
                            console.info(`NATS connected: ${info}`);
                        } else {
                            // debug-level info for other statuses
                            // you can change this to console.info if you prefer more verbosity
                            console.debug(`NATS status: ${info}`);
                        }
                    }
                } catch (err) {
                    // status iterator ends when connection is closed; log and continue
                    console.warn('NATS status iterator ended:', err?.message ?? err);
                } finally {
                    this._statusWatcherStarted = false;
                }
            })();
        }

        return this.nc;
    }

    /**
     * Register service handlers.
     * Handlers receive positional args: e.g. add: async (a, b) => a + b
     * If handler declares more parameters than the provided args, the original message 'm'
     * will be passed as the last argument (useful for inspecting headers/reply/etc).
     */
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
                            // respond with invalid JSON error if possible
                            if (m.respond) {
                                m.respond(
                                    jc.encode({
                                        __error: true,
                                        message: 'invalid JSON payload',
                                        stack: err?.message,
                                    })
                                );
                            }
                            continue;
                        }

                        // Normalize args: array => spread, non-array => single arg, undefined => none
                        const args =
                            payload === undefined
                                ? []
                                : Array.isArray(payload)
                                ? payload
                                : [payload];

                        try {
                            // If handler declared more params than args, append message m as last arg
                            let result;
                            if (typeof h === 'function') {
                                if (h.length > args.length) {
                                    result = await h(...args, m);
                                } else {
                                    result = await h(...args);
                                }
                            } else {
                                // not a function — skip
                                throw new Error('Service handler is not a function');
                            }

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
                            } else {
                                console.error(`Service handler error (no reply) for ${subj}:`, err);
                            }
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
     * NOTE: `data` is expected to be the array of positional args (or a single value/non-array).
     * The helpers getFunction / getService.fn supply an array of args when calling this method.
     *
     * options:
     *  - timeout: number (ms) - overrides defaultTimeout
     *  - retries: number - how many times to retry after the first attempt (default 3)
     *  - retryDelay: number - base delay in ms for backoff (default 1000)
     *  - maxRetryDelay: number - maximum delay in ms (default 20000)
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

        // Always encode positional args as JSON array when sending.
        // If caller passed a non-array single value intentionally, we send it as-is (not wrapped),
        // but our helpers will pass an array.
        const payloadToSend = Array.isArray(data) ? data : data;

        while (true) {
            try {
                const msg = await this.nc.request(subject, jc.encode(payloadToSend), { timeout });
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

    /**
     * Backwards-compatible helper: возвращает функцию для одного RPC
     * getFunction(service, method, options?)
     * Возвращаемая функция принимает позиционные аргументы: fn(...params)
     */
    getFunction(service, method, options = {}) {
        const subject = `${service}.${method}`;
        return async (...params) => {
            // send params as array of positional args
            return this.call(subject, params, options);
        };
    }

    /**
     * Новый API: getService(service)
     * Возвращает объект с методом fn(method, options?)
     * fn возвращает функцию(...params) — принимает только позиционные аргументы.
     */
    getService(service) {
        const self = this;
        return {
            name: service,
            fn(method, options = {}) {
                const subject = `${service}.${method}`;
                return async (...params) => {
                    return self.call(subject, params, options);
                };
            },
            create(methods = [], options = {}) {
                const out = {};
                for (const m of methods) {
                    out[m] = this.fn(m, options);
                }
                return out;
            },
        };
    }

    /**
     * Subscribe helper — on(subject, handler)
     * Handler will receive positional args (like service handlers).
     * If handler declares more params than delivered args, message 'm' will be passed as last arg.
     */
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

                    const args =
                        payload === undefined ? [] : Array.isArray(payload) ? payload : [payload];

                    try {
                        if (typeof h === 'function') {
                            if (h.length > args.length) {
                                await h(...args, m);
                            } else {
                                await h(...args);
                            }
                        }
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
