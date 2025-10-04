import { connect, JSONCodec } from 'nats';

const jc = JSONCodec();

function _streamNameForSubject(subject) {
    // простая детерминистическая функция для названия стрима
    return `js_stream_${String(subject).replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export class NATS {
    constructor(connectionConfig = {}, opts = {}) {
        this.connectionConfig = connectionConfig;
        this.defaultTimeout = opts.defaultTimeout ?? 1000; // ms
        this.nc = null;

        // JetStream contexts (инициализируются лениво)
        this.js = null; // jetstream client (produce/consume)
        this.jsm = null; // jetstream manager (create streams/consumers)

        this._subs = new Set();
        this._jsStreamsEnsured = new Set(); // чтобы не создавать стримы постоянно
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

    // === JetStream init/helpers ===
    async initJetStream() {
        await this.connect();
        if (this.js && this.jsm) return { js: this.js, jsm: this.jsm };
        // jetstream contexts
        this.js = await this.nc.jetstream();
        this.jsm = await this.nc.jetstreamManager();
        return { js: this.js, jsm: this.jsm };
    }

    async ensureStreamForSubject(subject, opts = {}) {
        // creates stream if not exists. opts may include no_ack, retention, etc.
        await this.initJetStream();
        const streamName = opts.streamName || _streamNameForSubject(subject);
        if (this._jsStreamsEnsured.has(streamName)) return streamName;

        try {
            await this.jsm.streams.info(streamName);
            this._jsStreamsEnsured.add(streamName);
            return streamName;
        } catch (err) {
            // stream not found -> create
            const streamConfig = {
                name: streamName,
                subjects: [subject],
                // по умолчанию создаём простую конфигурацию;
                // важно: если сообщения содержат reply, рекомендуется no_ack: true
                no_ack: opts.no_ack ?? true,
                retention: opts.retention ?? 'limits', // можно переопределить
                max_msgs: opts.max_msgs ?? -1,
                max_bytes: opts.max_bytes ?? -1,
                max_age: opts.max_age ?? 0,
                num_replicas: opts.num_replicas ?? 1,
            };
            try {
                await this.jsm.streams.add(streamConfig);
                this._jsStreamsEnsured.add(streamName);
                console.info(`Created JS stream ${streamName} for subject ${subject}`);
                return streamName;
            } catch (e) {
                // возможно пару процессов одновременно пытаются создать — попробуем читать info снова
                try {
                    await this.jsm.streams.info(streamName);
                    this._jsStreamsEnsured.add(streamName);
                    return streamName;
                } catch (e2) {
                    throw e; // пробрасываем оригинальную ошибку
                }
            }
        }
    }

    // === старые (core) методы: service(), call(), on(), emit() ===
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
                            const replyErr = {
                                __error: true,
                                message: 'invalid JSON payload',
                                stack: err?.message,
                            };
                            if (m.respond) m.respond(jc.encode(replyErr));
                            continue;
                        }
                        try {
                            const result = await h(payload, m);
                            if (m.respond) {
                                m.respond(jc.encode({ __ok: true, result }));
                            }
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
                                } catch (e) {
                                    console.error(`Failed respond error:`, e);
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

    async call(subject, data = undefined, options = {}) {
        await this.connect();
        const timeout = typeof options.timeout === 'number' ? options.timeout : this.defaultTimeout;
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
            const errCodeStr = String(err?.code ?? '');
            const noRespondersDetected =
                err?.code === 'NO_RESPONDERS' ||
                errCodeStr === 'NO_RESPONDERS' ||
                errCodeStr === '503' ||
                /\bno responders\b/i.test(errMsg) ||
                /\b503\b/.test(errMsg);

            if (noRespondersDetected) {
                const e = new Error(`No responders for subject ${subject}`);
                e.code = 'RPC_NO_RESPONDERS';
                throw e;
            }
            throw err;
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

    // === NEW: JetStream-backed RPC + service ===

    /**
     * callPersist(subject, data, options)
     * - публикация запроса в JetStream (стрим создаётся автоматически)
     * - ждёт ответа на временный reply-inbox (reply must be delivered by service)
     * options:
     *   - timeout (ms)
     *   - jsStreamOptions: passed to ensureStreamForSubject (e.g. { no_ack: true } )
     */
    async callPersist(subject, data = undefined, options = {}) {
        await this.connect();
        await this.initJetStream();

        const timeout = typeof options.timeout === 'number' ? options.timeout : this.defaultTimeout;
        const jsStreamOptions = options.jsStreamOptions ?? { no_ack: true };

        // ensure stream exists for this subject
        await this.ensureStreamForSubject(subject, jsStreamOptions);

        // create a one-time inbox for reply
        const replyInbox = this.nc.createInbox();
        const replySub = this.nc.subscribe(replyInbox, { max: 1 });
        this._subs.add(replySub);

        try {
            // publish into JetStream with reply so service can respond to our inbox
            const pa = await this.js.publish(subject, jc.encode(data ?? null), {
                reply: replyInbox,
            });
            // pa contains stream/seq info if needed (pa.seq, pa.stream)
            // now wait for reply or timeout
            const msgPromise = (async () => {
                for await (const m of replySub) {
                    return m;
                }
            })();

            const timeoutPromise = new Promise((_, rej) => {
                const t = setTimeout(() => {
                    const e = new Error(
                        `RPC timeout after ${timeout}ms for subject ${subject} (callPersist)`
                    );
                    e.code = 'RPC_TIMEOUT';
                    e.timeout = timeout;
                    rej(e);
                }, timeout);
                // ensure timer is cleared by msgPromise when resolved
                msgPromise.finally(() => clearTimeout(t));
            });

            const m = await Promise.race([msgPromise, timeoutPromise]);

            if (!m) {
                const e = new Error('No reply message received (unknown reason)');
                e.code = 'RPC_NO_REPLY';
                throw e;
            }

            const resp = m.data && m.data.length ? jc.decode(m.data) : undefined;
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
        } finally {
            // cleanup subscription (drain will remove ephemeral consumer)
            try {
                await replySub.drain();
            } catch (e) {
                try {
                    replySub.unsubscribe();
                } catch (_) {}
            }
            this._subs.delete(replySub);
        }
    }

    /**
     * servicePersist(name, handlers, serviceOpts)
     * - handlers: { methodName: async (data, msg) => result }
     * - serviceOpts: { queue, streamOpts }  queue - deliver group; streamOpts forwarded to ensureStreamForSubject
     *
     * Notes:
     *  - consumer created as durable per service-method (durableName derived). Multiple instances should set same service name+queue
     *  - after handler returns, we respond to reply subject (if present) and ack the JetStream message
     */
    async servicePersist(name, handlers = {}, serviceOpts = {}) {
        await this.initJetStream();

        for (const [method, handler] of Object.entries(handlers)) {
            const subject = `${name}.${method}`;
            const queue = serviceOpts.queue ?? undefined; // optional
            const streamOpts = serviceOpts.streamOpts ?? { no_ack: true };

            // ensure stream exists
            const streamName = await this.ensureStreamForSubject(subject, streamOpts);

            // durable consumer name
            const durableName = `${name}_${method}_durable`;

            // subscribe via JetStream (push subscription with durable)
            // js.subscribe supports options like { durable, queue }
            let sub;
            try {
                sub = await this.js.subscribe(subject, { durable: durableName, queue });
            } catch (err) {
                // fallback: create consumer via jsm and then subscribe
                try {
                    await this.jsm.consumers.add(streamName, {
                        durable_name: durableName,
                        ack_policy: 'explicit',
                    });
                    sub = await this.js.subscribe(subject, { durable: durableName, queue });
                } catch (e) {
                    console.error('Failed to create durable consumer for', subject, e);
                    throw e;
                }
            }

            this._subs.add(sub);

            (async (s, h, subj, dName) => {
                console.log(`ServicePersist listening (JS): ${subj} (durable=${dName})`);
                try {
                    for await (const m of s) {
                        // m is a JetStream message - behaves like regular Msg plus ack/NAK/etc.
                        let payload;
                        try {
                            payload = m.data && m.data.length ? jc.decode(m.data) : undefined;
                        } catch (err) {
                            // reply with decoding error then ack to remove from stream
                            const replyErr = {
                                __error: true,
                                message: 'invalid JSON payload',
                                stack: err?.message,
                            };
                            try {
                                if (m.respond) m.respond(jc.encode(replyErr));
                            } catch (_) {}
                            try {
                                await m.ack();
                            } catch (_) {}
                            continue;
                        }

                        try {
                            const result = await h(payload, m);
                            // respond if reply subject presented
                            if (m.reply) {
                                try {
                                    m.respond(jc.encode({ __ok: true, result }));
                                } catch (e) {
                                    console.error('respond failed:', e);
                                }
                            }
                            // acknowledge processed message so it's removed
                            try {
                                await m.ack();
                            } catch (e) {
                                console.warn('ack failed:', e);
                            }
                        } catch (err) {
                            // send structured error back to reply subject if exists
                            const remoteErr = {
                                __error: true,
                                message: err?.message ?? String(err),
                                stack: err?.stack,
                                name: err?.name,
                            };
                            if (m.reply) {
                                try {
                                    m.respond(jc.encode(remoteErr));
                                } catch (e) {
                                    console.error('respond error:', e);
                                }
                            }
                            // We ACK even on handler error to avoid repeated redelivery.
                            // If you want retry-on-failure semantics, change to m.nak() or skip ack.
                            try {
                                await m.ack();
                            } catch (e) {
                                console.warn('ack after error failed:', e);
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`JetStream subscription for ${subj} closed:`, err?.message ?? err);
                } finally {
                    this._subs.delete(s);
                }
            })(sub, handler, subject, durableName).catch((e) =>
                console.error('servicePersist launcher error:', e)
            );
        }
    }

    // === shutdown ===
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
