import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAutomatedSender,
  hasBulkHeaders,
  classifyEmailType,
  buildScopedGmailQuery,
  isMutualCorrespondent,
} from "./email-triage.js";

describe("email-triage", () => {
  describe("isAutomatedSender", () => {
    it("identifies automated bot prefixes", () => {
      assert.equal(isAutomatedSender("no-reply@uber.com"), true);
      assert.equal(isAutomatedSender("DoNotReply@notifications.github.com"), true);
      assert.equal(isAutomatedSender("billing@aws.amazon.com"), true);
      assert.equal(isAutomatedSender("news@e.target.com"), true);
      assert.equal(isAutomatedSender("Support Team <support@company.com>"), true);
    });

    it("does not flag real human senders", () => {
      assert.equal(isAutomatedSender("micha@example.com"), false);
      assert.equal(isAutomatedSender("Alice Smith <alice.smith@client.org>"), false);
      assert.equal(isAutomatedSender("bob_engineer@gmail.com"), false);
    });
  });

  describe("hasBulkHeaders", () => {
    it("detects List-Unsubscribe and List-Id headers", () => {
      assert.equal(hasBulkHeaders({ "List-Unsubscribe": "<https://unsub.com>" }), true);
      assert.equal(hasBulkHeaders({ "list-id": "<marketing.target.com>" }), true);
    });

    it("detects Precedence and Auto-Submitted headers", () => {
      assert.equal(hasBulkHeaders({ "Precedence": "bulk" }), true);
      assert.equal(hasBulkHeaders({ "Auto-Submitted": "auto-generated" }), true);
    });

    it("returns false for direct human headers", () => {
      assert.equal(hasBulkHeaders({ "Message-ID": "<abc@example.com>", "To": "micha@example.com" }), false);
    });
  });

  describe("classifyEmailType", () => {
    it("classifies direct emails as HUMAN", () => {
      const res = classifyEmailType({}, "alice@company.com", "Project Status Update");
      assert.equal(res.category, "HUMAN");
    });

    it("classifies automated receipts as TRANSACTIONAL", () => {
      const res = classifyEmailType({}, "receipts@uber.com", "Your Friday afternoon trip receipt");
      assert.equal(res.category, "TRANSACTIONAL");
    });

    it("classifies bulk newsletters as BULK_IGNORE", () => {
      const res = classifyEmailType({ "List-Unsubscribe": "<url>" }, "news@marketing.com", "50% off sale");
      assert.equal(res.category, "BULK_IGNORE");
    });
  });

  describe("buildScopedGmailQuery", () => {
    it("includes exclusions for promotions, social, spam, and trash", () => {
      const query = buildScopedGmailQuery(30);
      assert.ok(query.includes("newer_than:30d"));
      assert.ok(query.includes("-category:promotions"));
      assert.ok(query.includes("-category:social"));
      assert.ok(query.includes("-is:spam"));
      assert.ok(query.includes("-is:trash"));
    });
  });

  describe("isMutualCorrespondent", () => {
    it("returns true when user and another participant are present", () => {
      assert.equal(isMutualCorrespondent(["micha@example.com", "colleague@work.com"], "micha@example.com"), true);
    });

    it("returns false when user is not a participant", () => {
      assert.equal(isMutualCorrespondent(["other@work.com", "someone@work.com"], "micha@example.com"), false);
    });
  });
});
