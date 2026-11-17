const { fromEvent } = require("./notify");

const decoder = new TextDecoder();

// Listens to the chaincode events of the channel and turns them into notifications.
//
//   source({ checkpoint })   opens the event stream (services/fabric.js ledger.events)
//   checkpointer             remembers the last event handled, so after a restart or a lost
//                            connection the stream resumes where it was and nothing is missed
//
// An event is checkpointed after it is handled: if the process dies in between, the event comes
// again and the store drops the duplicate (at-least-once delivery, idempotent handling).
function createEventListener({ source, checkpointer, store, webhooks, log = console, retryMs = 2000, maxRetryMs = 30000 }) {
    let stopped = false;
    let stream = null;
    let wake = null;
    let running = null;

    function handle(event) {
        let payload;
        try {
            payload = JSON.parse(decoder.decode(event.payload));
        } catch {
            return; // not one of ours
        }
        const notification = fromEvent({ name: event.eventName, payload, txId: event.transactionId, block: event.blockNumber });
        const stored = notification && store.add(notification);
        if (stored && webhooks) webhooks.send(stored);
    }

    async function run() {
        let wait = retryMs;
        let announced = false;
        let warned = false;
        while (!stopped) {
            try {
                stream = await source({ checkpoint: checkpointer });
                if (!announced) log.log("🔔 Listening to chaincode events");
                announced = true;
                for await (const event of stream) {
                    handle(event);
                    await checkpointer.checkpointChaincodeEvent(event);
                    wait = retryMs;
                    warned = false;
                }
            } catch (err) {
                if (stopped) break;
                // Say it once per outage, not on every retry.
                if (!warned) log.warn(`⚠️  chaincode events: ${err.message}; retrying`);
                warned = true;
            } finally {
                if (stream) stream.close();
                stream = null;
            }
            if (stopped) break;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, wait);
                wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            wait = Math.min(wait * 2, maxRetryMs);
        }
    }

    return {
        start() {
            if (!running) running = run();
            return running;
        },
        async stop() {
            stopped = true;
            if (stream) stream.close();
            if (wake) wake();
            await running;
        },
    };
}

module.exports = { createEventListener };
