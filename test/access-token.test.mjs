import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessToken, isAccessLogin } from "../scripts/access-token.mjs";

const ID = "0123456789abcdef0123456789abcdef.access";
const SECRET = "cfast_" + "a".repeat(48);

test("clean values pass through as headers", () => {
  const t = accessToken({ CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
  assert.deepEqual(t.problems, []);
  assert.deepEqual(t.headers, { "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET });
});

test("whitespace, newlines and header prefixes are stripped", () => {
  const t = accessToken({ CF_ACCESS_CLIENT_ID: `  CF-Access-Client-Id: ${ID} \r\n`, CF_ACCESS_CLIENT_SECRET: `cf-access-client-secret:${SECRET}\n` });
  assert.deepEqual(t.headers, { "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET });
  assert.match(t.shape, /whitespace or a header prefix was removed/);
});

test("swapped, missing or wrong-shaped values are refused without revealing them", () => {
  const swapped = accessToken({ CF_ACCESS_CLIENT_ID: SECRET, CF_ACCESS_CLIENT_SECRET: ID });
  assert.equal(swapped.headers, null);
  assert.match(swapped.problems.join(" "), /swapped/);
  assert.ok(!swapped.shape.includes(SECRET) && !swapped.shape.includes(ID), "shape never contains the values");
  assert.match(accessToken({ CF_ACCESS_CLIENT_ID: ID }).problems.join(" "), /set both/);
  assert.match(accessToken({ CF_ACCESS_CLIENT_ID: "3537a672-e4d8-4d89-aab9-26cb622918a1", CF_ACCESS_CLIENT_SECRET: SECRET }).problems.join(" "), /ends with \.access/);
  assert.deepEqual(accessToken({}), { headers: null, problems: [], shape: "not set" });
});

test("an Access login redirect is recognised; other answers are not", () => {
  const res = (status, location) => ({ status, headers: new Headers(location ? { location } : {}) });
  assert.ok(isAccessLogin(res(302, "https://cryptophys.cloudflareaccess.com/cdn-cgi/access/login/nexus.cryptophys.work")));
  assert.ok(!isAccessLogin(res(200)));
  assert.ok(!isAccessLogin(res(302, "https://nexus.cryptophys.work/")));
});

test("both deploy smoke tests use the helper and never follow a redirect with the token", () => {
  for (const file of ["deploy-worker.yml", "deploy-nexus-dashboard.yml"]) {
    const wf = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assert.match(wf, /import \{ accessToken, isAccessLogin \} from "\.\/scripts\/access-token\.mjs"/, file);
    assert.match(wf, /redirect: "manual", headers: (TOKEN|token\.headers)/, `${file}: the token probe sees an Access refusal`);
  }
});
