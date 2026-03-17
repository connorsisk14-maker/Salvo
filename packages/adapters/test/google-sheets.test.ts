import assert from "node:assert/strict";
import test from "node:test";
import { GoogleSheetsAdapter } from "../src/google-sheets";

const credentialsJson = JSON.stringify({
  client_email: "service-account@salvo.test",
  private_key: "-----BEGIN PRIVATE KEY-----\\nMIIBOjANBgkqhkiG9w0BAQEFAAOCAY8AMIIBCgKCAQEAx\\n-----END PRIVATE KEY-----\\n"
});

test("GoogleSheetsAdapter read_range action calls the Sheets API", async () => {
  const capturedUrls: string[] = [];
  const adapter = new GoogleSheetsAdapter(
    {
      spreadsheetId: "sheet-abc",
      credentialsJson
    },
    {
    fetch: async (url) => {
      const asString = String(url);
      capturedUrls.push(asString);
      if (asString.includes("/values/sheet-name!A1%3AB2")) {
        return new Response(JSON.stringify({ values: [["alpha", "beta"]] }), {
          status: 200,
            headers: {
              "content-type": "application/json"
            }
          });
        }
        return new Response("{}", { status: 200 });
      },
      tokenProvider: async () => ({
        token: "test-token",
        expiresIn: 3600
      })
    }
  );

  const result = await adapter.run({
    runId: "read-run",
    payload: {
      action: "read_range",
      range: "sheet-name!A1:B2"
    }
  });

  assert.equal(result.ok, true);
  assert.ok(capturedUrls.some((url) => url.includes("/values/sheet-name!A1%3AB2")));
  assert.deepEqual(result.output, { values: [["alpha", "beta"]] });
});

test("GoogleSheetsAdapter rejects missing action", async () => {
  const adapter = new GoogleSheetsAdapter(
    {
      spreadsheetId: "sheet-abc",
      credentialsJson
    },
    {
      tokenProvider: async () => ({
        token: "token",
        expiresIn: 3600
      })
    }
  );

  const result = await adapter.run({
    runId: "missing-action",
    payload: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.detail, "Google Sheets action is required.");
});
