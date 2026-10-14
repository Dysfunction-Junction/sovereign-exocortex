import { test } from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { backfillComms, legacyDigits, loadContacts, normalizePhone, parseCsv } from "./comms-backfill.js";
import { PAST_KIND } from "./pieces-backfill.js";

// All numbers below are fictitious (555 exchange).
const CONTACTS = [
  "First Name,Last Name,Organization Name,Labels,Notes,Phone 1 - Value,Phone 2 - Value",
  'Mom,,,"* family ::: Imported on 1/29 ::: * myContacts","secret note, with comma\nand newline",(281) 555-0101,',
  "Sam,Vendor,,Vendors ::: * myContacts,,+1 979-555-0102 ::: (979) 555-0102,#225",
  "#BAL -,Check,,* myContacts,,#225,",
].join("\n");

const FI = [
  '"Date (-05:00)","Time (-05:00)","Phone #","Type","Duration","Rate","Cost"',
  '"Oct 2, 2026","11:59 PM","(281) 555-0101","Sent text","","",""',
  '"Oct 2, 2026","11:59 PM","(281) 555-0101","Sent text","","",""',
  '"Oct 2, 2026","9:00 AM","(979) 555-0102","Incoming call","1:05:07","",""',
  '"Oct 2, 2026","9:00 AM","Unknown","Incoming call","1:05:07","",""',
  '"Oct 2, 2026","9:05 AM","28777","Received text","","",""',
  '"Oct 2, 2026","9:06 AM","(979) 555-0199","Missed call","","",""',
  '"Oct 2, 2026","9:07 AM","(281) 555-0101,(979) 555-0102","Received text","","",""',
  '"garbage","row","x","Sent text","","",""',
].join("\n");

const SALT = "0123456789abcdef0123";

test("parseCsv handles quoted commas, newlines and escaped quotes", () => {
  assert.deepEqual(parseCsv('a,"b,c","d\ne","f""g"\n1,2,3,4'), [["a", "b,c", "d\ne", 'f"g'], ["1", "2", "3", "4"]]);
});

test("normalizePhone keeps 10-digit NANP and valid E.164 international numbers", () => {
  assert.equal(normalizePhone("+1 979-555-0102"), "9795550102");
  assert.equal(normalizePhone("+44 20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("+65 8123 4567"), "6581234567");
  assert.equal(normalizePhone("#225"), null);
  assert.equal(normalizePhone("74*27*63"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("+1 979 555 010"), null);
  assert.equal(normalizePhone("tel:+442079460958"), "442079460958");
  assert.equal(normalizePhone("+1 979-555-0102 x12"), "9795550102");
  assert.equal(normalizePhone("+44 (0)20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("+44 20 7946 0958,123"), "442079460958");
  assert.equal(normalizePhone("+1 979-555-0102;ext=123"), "9795550102");
  assert.equal(normalizePhone("+1 979 555 0102 ext. 12"), "9795550102");
  assert.equal(normalizePhone("(979) 555-0102"), "9795550102");
  assert.equal(normalizePhone("001 979 555 0102"), "9795550102");
  assert.equal(normalizePhone("00 44 20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("011 44 20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("0044 20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("442079460958"), "442079460958");
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("+"), null);
  assert.equal(normalizePhone("+0 12345678"), null);
  assert.equal(normalizePhone("+1 979-555-0102\nx12"), "9795550102");
  assert.equal(normalizePhone("1 979 555 0102 99"), null);
  assert.equal(normalizePhone("0123456789"), null);
  assert.equal(normalizePhone("020 7946 0958"), null);
  assert.equal(normalizePhone(" ".repeat(50000)), null);
});

test("legacyDigits preserves legacy digits while stripping leading 1 and rejecting noise", () => {
  assert.equal(legacyDigits("+1 979-555-0102"), "9795550102");
  assert.equal(legacyDigits("+44 20 7946 0958"), "442079460958");
  assert.equal(legacyDigits("555-0102"), "5550102");
  assert.equal(legacyDigits("#225"), null);
  assert.equal(legacyDigits("123"), null);
  assert.equal(legacyDigits(""), null);
  assert.equal(legacyDigits("+++"), null);
});

test("loadContacts maps every number of a contact and drops noise", () => {
  const m = loadContacts(CONTACTS);
  assert.equal(m.get("2815550101")?.id, "person_mom");
  assert.deepEqual(m.get("2815550101")?.labels, ["family"]);
  assert.equal(m.get("9795550102")?.id, "person_sam_vendor");
  assert.equal(m.size, 2);
});

test("backfill writes hashed, deduped past events and never stores raw numbers", () => {
  const db = new ExocortexDatabase();
  const r = backfillComms(db, FI, CONTACTS, SALT);
  assert.equal(r.automated, 1);
  assert.equal(r.unknownDuplicates, 1);
  assert.equal(r.malformed, 1);
  assert.equal(r.inserted, 5); // two identical sent texts + call + missed + group text
  const events = db.listEvents({ kind: PAST_KIND });
  assert.equal(events.length, 5);
  const blob = events.map((e) => String(e.payload)).join("");
  assert.doesNotMatch(blob, /555|979|281/);
  const call = events.map((e) => JSON.parse(String(e.payload))).find((p) => p.type === "call" && p.direction === "in");
  assert.equal(call.duration_s, 3907);
  assert.deepEqual(call.people, ["person_sam_vendor"]);
  const group = events.map((e) => JSON.parse(String(e.payload))).find((p) => p.group);
  assert.deepEqual(group.people.sort(), ["person_mom", "person_sam_vendor"]);
  const midnightish = events.find((e) => e.ts_device === Date.UTC(2026, 9, 3, 4, 59));
  assert.ok(midnightish, "11:59 PM at -05:00 is 04:59 UTC the next day");
  assert.equal(db.verifyEventChain().valid, true);
});

test("backfill is idempotent", () => {
  const db = new ExocortexDatabase();
  backfillComms(db, FI, CONTACTS, SALT);
  const again = backfillComms(db, FI, CONTACTS, SALT);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicate, 5);
});

test("times with a narrow no-break space before AM/PM parse", () => {
  const db = new ExocortexDatabase();
  const fi =
    '"Date (-05:00)","Time (-05:00)","Phone #","Type","Duration","Rate","Cost"\n' +
    '"Oct 2, 2026","9:00\u202FAM","(281) 555-0101","Sent text","","",""';
  const r = backfillComms(db, fi, CONTACTS, SALT);
  assert.equal(r.malformed, 0);
  assert.equal(r.inserted, 1);
});

test("a weak salt is refused", () => {
  assert.throws(() => backfillComms(new ExocortexDatabase(), FI, CONTACTS, "short"), /salt/);
});
