import { createApp } from "/home/user/paperkite-hq/stork/src/api/server.ts";
import { createTestDb, createTestContext, createTestInboundConnector, createTestFolder, createTestMessage } from "/home/user/paperkite-hq/stork/src/test-helpers/test-db.ts";
const db = createTestDb();
const c = createTestInboundConnector(db);
const f = createTestFolder(db, c, "INBOX");
createTestMessage(db, c, f, 1, { subject: "quarterly report", textBody: "hello world" });
const ctx = createTestContext(db);
if (ctx.scheduler) await ctx.scheduler.stop();
const { app } = createApp(ctx);
for (const q of ["e-mail", "Re: invoice", "john@example.com", "follow-up", "C++", "50%", "it's", "dont"]) {
  const r = await app.request(`/api/search?q=${encodeURIComponent(q)}`);
  const body = await r.text();
  console.log(JSON.stringify(q).padEnd(20), r.status, body.slice(0, 90));
}
const r = await app.request(`/api/does-not-exist`);
console.log("unknown api route:", r.status, r.headers.get("content-type"));
process.exit(0);
