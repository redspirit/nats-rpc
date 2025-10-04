const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('NATS wrapper (unit tests)', function () {
    let NATS;
    let mockNatsModule;
    let sandbox;

    // helper: create a fresh mock 'nats' module per test with configurable behavior
    function createMockNats(stubs = {}) {
        // JSONCodec simple impl (encode -> Buffer, decode -> JSON.parse)
        function JSONCodec() {
            return {
                encode: (obj) => {
                    if (obj === undefined) return Buffer.from('');
                    return Buffer.from(JSON.stringify(obj));
                },
                decode: (buf) => {
                    if (!buf || buf.length === 0) return undefined;
                    return JSON.parse(Buffer.from(buf).toString());
                },
            };
        }

        // fake JetStream message factory
        function makeJsMsg(payloadObj, replySubject, jsMethods = {}) {
            const codec = JSONCodec();
            const data = codec.encode(payloadObj);
            let ackCalled = false;
            let nakCalled = false;
            let responded = [];
            return {
                data,
                reply: replySubject,
                // respond behaves like `m.respond()` in wrapper
                respond: (b) => {
                    // decode for test readability
                    const decoded = codec.decode(b);
                    responded.push(decoded);
                },
                ack: async () => {
                    ackCalled = true;
                },
                nak: async () => {
                    nakCalled = true;
                },
                // expose for assertions
                _meta: {
                    ackCalled: () => ackCalled,
                    nakCalled: () => nakCalled,
                    responded,
                },
            };
        }

        // Utility used by callPersist tests: create a reply-sub that can be manually push()ed.
        function makeReplySub() {
            let pullQueue = [];
            let resolves = [];
            const sub = {
                push: (msg) => {
                    if (resolves.length > 0) {
                        const r = resolves.shift();
                        r({ value: msg, done: false });
                    } else {
                        pullQueue.push(msg);
                    }
                },
                // implement async iterator protocol
                [Symbol.asyncIterator]() {
                    return this;
                },
                next() {
                    if (pullQueue.length > 0) {
                        const msg = pullQueue.shift();
                        return Promise.resolve({ value: msg, done: false });
                    }
                    return new Promise((resolve) => {
                        resolves.push(resolve);
                    });
                },
                drain: async () => {},
                unsubscribe: () => {},
            };
            return sub;
        }

        // Create core connection object and allow overriding of individual methods via stubs
        const nc = {
            // will be overridden in tests as needed
            request: stubs.request || sinon.stub(),
            subscribe: stubs.subscribe || sinon.stub(),
            createInbox: stubs.createInbox || (() => 'INBOX.1234'),
            jetstream:
                stubs.jetstream ||
                (async () => ({
                    // js.publish will be settable via stubs.jsPublish or default stub
                    publish: stubs.jsPublish || (async () => ({ seq: 1, stream: 'S' })),
                    subscribe:
                        stubs.jsSubscribe ||
                        (async () => {
                            // default js.subscribe: return an object with async iterator that yields nothing
                            const sub = {
                                [Symbol.asyncIterator]() {
                                    return this;
                                },
                                next() {
                                    return new Promise(() => {});
                                },
                                drain: async () => {},
                                unsubscribe: () => {},
                            };
                            return sub;
                        }),
                })),
            jetstreamManager:
                stubs.jsm ||
                (async () => ({
                    streams: {
                        info: async (name) => {
                            throw new Error('not found');
                        },
                        add: async (cfg) => ({ name: cfg.name }),
                    },
                    consumers: {
                        add: async () => ({}),
                    },
                })),
            flush: stubs.flush || (async () => {}),
            publish: stubs.publish || sinon.stub(),
            close: async () => {},
            drain: async () => {},
            closed: () => Promise.resolve(),
            createInboxSubFactory: makeReplySub, // helper for tests to access fake reply subs
        };

        // connect() returns the above nc
        async function connect(cfg) {
            return nc;
        }

        mockNatsModule = {
            connect,
            JSONCodec,
            // expose helpers to tests for constructing js messages
            __helpers: {
                makeJsMsg,
                makeReplySub,
            },
        };

        return mockNatsModule;
    }

    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });

    afterEach(function () {
        sandbox.restore();
    });

    function loadWrapperWithMock(mock) {
        // require the wrapper module, replacing 'nats' with our mock
        const wrapper = proxyquire('../nats-wrapper', {
            nats: mock,
        });
        return wrapper;
    }

    it('call() should return result on success', async function () {
        const mock = createMockNats();
        // stub request to resolve with encoded { __ok: true, result: 5 }
        const codec = mock.JSONCodec();
        mock.connect = async () => ({
            request: sinon.stub().resolves({ data: codec.encode({ __ok: true, result: 5 }) }),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({}),
            jetstreamManager: async () => ({}),
            closed: () => Promise.resolve(),
        });
        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS({}, { defaultTimeout: 1000 });
        await client.connect();
        const res = await client.call('math.add', { a: 2, b: 3 });
        expect(res).to.equal(5);
    });

    it('call() should throw RPC_TIMEOUT on request timeout', async function () {
        const mock = createMockNats();
        mock.connect = async () => ({
            request: sinon
                .stub()
                .rejects(Object.assign(new Error('Request timed out'), { code: 'REQ_TIMEOUT' })),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({}),
            jetstreamManager: async () => ({}),
            closed: () => Promise.resolve(),
        });
        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS({}, { defaultTimeout: 50 });
        await client.connect();
        try {
            await client.call('math.add', { a: 1 }, { timeout: 50 });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(Error);
            expect(err.code).to.equal('RPC_TIMEOUT');
            expect(err.message).to.match(/RPC timeout/);
        }
    });

    it('call() should throw RPC_NO_RESPONDERS when underlying error contains 503 or "no responders"', async function () {
        const mock = createMockNats();
        // variant 1: code 'NO_RESPONDERS'
        mock.connect = async () => ({
            request: sinon
                .stub()
                .rejects(
                    Object.assign(new Error('no responders for subject'), { code: 'NO_RESPONDERS' })
                ),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({}),
            jetstreamManager: async () => ({}),
            closed: () => Promise.resolve(),
        });
        let wrapper = loadWrapperWithMock(mock);
        let NATS = wrapper.default || wrapper.NATS;
        let client = new NATS({}, { defaultTimeout: 100 });
        await client.connect();
        try {
            await client.call('no.such', {}, { timeout: 100 });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.code).to.equal('RPC_NO_RESPONDERS');
        }

        // variant 2: numeric 503 in message
        mock.connect = async () => ({
            request: sinon.stub().rejects(new Error('503 Service Unavailable')),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({}),
            jetstreamManager: async () => ({}),
            closed: () => Promise.resolve(),
        });
        wrapper = loadWrapperWithMock(mock);
        NATS = wrapper.default || wrapper.NATS;
        client = new NATS({}, { defaultTimeout: 100 });
        await client.connect();
        try {
            await client.call('no.such', {}, { timeout: 100 });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.code).to.equal('RPC_NO_RESPONDERS');
        }
    });

    it('call() should surface remote handler error as RPC_REMOTE_ERROR', async function () {
        const mock = createMockNats();
        const codec = mock.JSONCodec();
        mock.connect = async () => ({
            request: sinon
                .stub()
                .resolves({
                    data: codec.encode({
                        __error: true,
                        message: 'boom',
                        stack: 'stacktrace',
                        name: 'TypeError',
                    }),
                }),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({}),
            jetstreamManager: async () => ({}),
            closed: () => Promise.resolve(),
        });
        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS({}, { defaultTimeout: 100 });
        await client.connect();
        try {
            await client.call('math.add', { a: 1 });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.code).to.equal('RPC_REMOTE_ERROR');
            expect(err.remoteStack).to.be.a('string');
            expect(err.message).to.equal('boom');
        }
    });

    it('on() should pass subscribe options (queue) to underlying nc.subscribe', async function () {
        const mock = createMockNats();
        // spy subscribe to capture opts
        let capturedOpts = null;
        mock.connect = async () => ({
            request: sinon.stub(),
            flush: async () => {},
            subscribe: (subject, opts) => {
                capturedOpts = opts;
                // return an async-iterator that ends immediately
                return {
                    [Symbol.asyncIterator]() {
                        return this;
                    },
                    next: async () => ({ done: true }),
                    drain: async () => {},
                    unsubscribe: () => {},
                };
            },
            createInbox: () => 'inbox',
            jetstream: async () => ({}),
            jetstreamManager: async () => ({}),
            closed: () => Promise.resolve(),
        });

        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS();
        await client.connect();
        await client.on('user.created', async () => {}, { queue: 'my-group' });
        expect(capturedOpts).to.be.an('object');
        expect(capturedOpts.queue).to.equal('my-group');
    });

    it('callPersist() should publish to JS and return reply result', async function () {
        const mock = createMockNats();
        const codec = mock.JSONCodec();

        // prepare reply subscription controllable by test
        const replySub = mock.__helpers.makeReplySub();
        const jsPublishStub = sinon.stub().resolves({ seq: 1, stream: 'S' });

        mock.connect = async () => {
            return {
                request: sinon.stub(),
                flush: async () => {},
                subscribe: sinon.stub(),
                createInbox: () => 'REPLY.INBOX',
                jetstream: async () => ({
                    publish: jsPublishStub,
                    subscribe: async () => {
                        /* not used here */
                    },
                }),
                jetstreamManager: async () => ({
                    streams: {
                        info: async (name) => {
                            throw new Error('not found');
                        },
                        add: async (cfg) => ({ name: cfg.name }),
                    },
                    consumers: { add: async () => ({}) },
                }),
                // subscribe used for the reply inbox in callPersist below -> we must return our replySub
                subscribe: (subject, opts) => {
                    // if subject is reply inbox, return the controlled replySub
                    if (subject === 'REPLY.INBOX') return replySub;
                    // fallback
                    return {
                        [Symbol.asyncIterator]() {
                            return this;
                        },
                        next: async () => ({ done: true }),
                        drain: async () => {},
                        unsubscribe: () => {},
                    };
                },
                createInboxSubFactory: mock.__helpers.makeReplySub,
                closed: () => Promise.resolve(),
            };
        };

        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS({}, { defaultTimeout: 1000 });
        await client.connect();

        // call callPersist (it will publish and then wait for reply)
        const callPromise = client.callPersist('math.add', { a: 2, b: 3 }, { timeout: 500 });

        // simulate service replying shortly
        const jsmsg = mock.__helpers.makeJsMsg({ __ok: true, result: 42 }, null);
        // push a message to replySub
        replySub.push({ data: codec.encode({ __ok: true, result: 42 }) });

        const res = await callPromise;
        expect(res).to.equal(42);
        expect(jsPublishStub.calledOnce).to.be.true;
    });

    it('callPersist() should timeout if no reply arrives', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const mock = createMockNats();
            const codec = mock.JSONCodec();
            // reply sub that never yields messages
            const replySub = {
                [Symbol.asyncIterator]() {
                    return this;
                },
                next() {
                    return new Promise(() => {});
                }, // never resolves
                drain: async () => {},
                unsubscribe: () => {},
            };
            const jsPublishStub = sinon.stub().resolves({ seq: 10, stream: 'S' });

            mock.connect = async () => ({
                request: sinon.stub(),
                flush: async () => {},
                subscribe: (subject) => {
                    if (subject === 'REPLY.INBOX') return replySub;
                    return {
                        [Symbol.asyncIterator]() {
                            return this;
                        },
                        next: async () => ({ done: true }),
                        drain: async () => {},
                    };
                },
                createInbox: () => 'REPLY.INBOX',
                jetstream: async () => ({ publish: jsPublishStub, subscribe: async () => ({}) }),
                jetstreamManager: async () => ({
                    streams: {
                        info: async (n) => {
                            throw new Error('not found');
                        },
                        add: async (c) => ({ name: c.name }),
                    },
                    consumers: { add: async () => ({}) },
                }),
                closed: () => Promise.resolve(),
            });

            const wrapper = loadWrapperWithMock(mock);
            const NATS = wrapper.default || wrapper.NATS;
            const client = new NATS({}, { defaultTimeout: 10 });
            await client.connect();

            const p = client.callPersist('math.add', { a: 1 }, { timeout: 100 });

            // advance fake timers to trigger the timeout path
            clock.tick(200);

            try {
                await p;
                throw new Error('should have timed out');
            } catch (err) {
                expect(err).to.be.instanceOf(Error);
                expect(err.code).to.equal('RPC_TIMEOUT');
            }
        } finally {
            clock.restore();
        }
    });

    it('servicePersist() should process JS message, respond and ack', async function () {
        const mock = createMockNats();
        const codec = mock.JSONCodec();
        // create a js.subscribe that gives a sub we can push messages to
        function makePushableSub() {
            let resolves = [];
            let queue = [];
            const sub = {
                push(msg) {
                    if (resolves.length > 0) {
                        const r = resolves.shift();
                        r({ value: msg, done: false });
                    } else {
                        queue.push(msg);
                    }
                },
                [Symbol.asyncIterator]() {
                    return this;
                },
                next() {
                    if (queue.length > 0) {
                        const m = queue.shift();
                        return Promise.resolve({ value: m, done: false });
                    }
                    return new Promise((resolve) => {
                        resolves.push(resolve);
                    });
                },
                drain: async () => {},
                unsubscribe: () => {},
            };
            return sub;
        }

        const pushSub = makePushableSub();
        // stub js.subscribe to return pushSub
        mock.connect = async () => ({
            request: sinon.stub(),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({
                publish: async () => ({}),
                subscribe: async () => pushSub,
            }),
            jetstreamManager: async () => ({
                streams: {
                    info: async (n) => {
                        throw new Error('not found');
                    },
                    add: async (c) => ({ name: c.name }),
                },
                consumers: { add: async () => ({}) },
            }),
            closed: () => Promise.resolve(),
        });

        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS({}, { defaultTimeout: 1000 });
        await client.connect();

        // register servicePersist handler
        const processed = [];
        await client.servicePersist(
            'math',
            {
                add: async (data, msg) => {
                    processed.push(data);
                    return data.a + data.b;
                },
            },
            { queue: undefined, streamOpts: { no_ack: true } }
        );

        // simulate incoming JS message with reply set
        const msg = mock.__helpers.makeJsMsg({ a: 2, b: 3 }, 'REPLY.INBOX');
        // push into subscription - servicePersist's loop should pick it up
        pushSub.push(msg);

        // allow event loop tick for handler to run
        await new Promise((res) => setImmediate(res));

        // assert that message was processed and responded / acked
        expect(processed.length).to.equal(1);
        // response should be available in msg._meta.responded
        expect(msg._meta.responded.length).to.equal(1);
        expect(msg._meta.responded[0].__ok).to.equal(true);
        expect(msg._meta.ackCalled()).to.be.true;
    });

    it('servicePersist() handler error should respond with __error and ack', async function () {
        const mock = createMockNats();
        const pushSub = (function makePushableSub() {
            let resolves = [];
            let queue = [];
            const sub = {
                push(msg) {
                    if (resolves.length > 0) {
                        const r = resolves.shift();
                        r({ value: msg, done: false });
                    } else {
                        queue.push(msg);
                    }
                },
                [Symbol.asyncIterator]() {
                    return this;
                },
                next() {
                    if (queue.length > 0) {
                        const m = queue.shift();
                        return Promise.resolve({ value: m, done: false });
                    }
                    return new Promise((resolve) => {
                        resolves.push(resolve);
                    });
                },
                drain: async () => {},
                unsubscribe: () => {},
            };
            return sub;
        })();

        mock.connect = async () => ({
            request: sinon.stub(),
            flush: async () => {},
            subscribe: sinon.stub(),
            createInbox: () => 'inbox',
            jetstream: async () => ({
                publish: async () => ({}),
                subscribe: async () => pushSub,
            }),
            jetstreamManager: async () => ({
                streams: {
                    info: async (n) => {
                        throw new Error('not found');
                    },
                    add: async (c) => ({ name: c.name }),
                },
                consumers: { add: async () => ({}) },
            }),
            closed: () => Promise.resolve(),
        });

        const wrapper = loadWrapperWithMock(mock);
        const NATS = wrapper.default || wrapper.NATS;
        const client = new NATS({}, { defaultTimeout: 1000 });
        await client.connect();

        await client.servicePersist(
            'math',
            {
                explode: async () => {
                    throw new Error('boom!');
                },
            },
            { streamOpts: { no_ack: true } }
        );

        const msg = mock.__helpers.makeJsMsg({ x: 1 }, 'REPLY.INBOX');
        pushSub.push(msg);

        // allow event loop tick
        await new Promise((res) => setImmediate(res));

        // should have responded with __error and still acked
        expect(msg._meta.responded.length).to.equal(1);
        expect(msg._meta.responded[0].__error).to.equal(true);
        expect(msg._meta.ackCalled()).to.be.true;
    });
});
