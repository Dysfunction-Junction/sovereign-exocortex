import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeopleResolver,
  normalizePhone,
  parseCubeContactString,
  slugifyPersonName,
  CanonicalPerson,
} from '../people-resolver.js';

// Pure synthetic test seed with zero real-world PII
const SYNTHETIC_SEED: Array<Omit<CanonicalPerson, 'sourceItemIds' | 'interactionCount'>> = [
  {
    id: 'person_test_spouse',
    name: 'Jane Doe',
    relationship: 'wife',
    aliases: ['Jane', 'Jane Doe', 'Wife'],
    phones: ['+15552345678'],
    emails: ['jane.doe@example.com'],
    tags: ['family', 'wife', 'core'],
  },
  {
    id: 'person_test_mother',
    name: 'Mom Mary',
    relationship: 'mother',
    aliases: ['Mom', 'Mom Mary', 'Mary Doe'],
    phones: ['+15559876543'],
    emails: ['mary.doe@example.com'],
    tags: ['family', 'mother', 'core'],
  },
  {
    id: 'person_test_father',
    name: 'Dad John',
    relationship: 'father',
    aliases: ['Daddy', 'Dad', 'Dad John'],
    phones: ['+15558765432'],
    emails: [],
    tags: ['family', 'father', 'core'],
  },
  {
    id: 'person_aunt_test',
    name: 'Aunt Alice',
    relationship: 'aunt',
    aliases: ['Aunt Alice', 'Alice Smith'],
    phones: ['+15557654321', '+15557654322'],
    emails: ['alice@example.com'],
    notes: 'Test note only',
    tags: ['family', 'aunt', 'core'],
  },
  {
    id: 'person_uncle_test',
    name: 'Uncle Bob',
    relationship: 'uncle',
    aliases: ['Uncle Bob', 'Bob Smith'],
    phones: ['+15557654399'],
    emails: [],
    tags: ['family', 'uncle', 'core'],
  },
];

describe('PeopleResolver', () => {
  describe('normalizePhone', () => {
    it('normalizes 10-digit NANP phone numbers to E.164', () => {
      assert.deepEqual(normalizePhone('5552345678'), ['+15552345678']);
      assert.deepEqual(normalizePhone('(555) 234-5678'), ['+15552345678']);
      assert.deepEqual(normalizePhone('+1 555-234-5678'), ['+15552345678']);
    });

    it('rejects invalid NANP (leading 0 or 1 in area code)', () => {
      // Area code starting with 0 or 1 is invalid in NANP
      assert.deepEqual(normalizePhone('0123456789'), []);
      assert.deepEqual(normalizePhone('1123456789'), []);
    });

    it('rejects short numbers that are not full phone numbers', () => {
      assert.deepEqual(normalizePhone('1234567'), []);
      assert.deepEqual(normalizePhone('31706'), []);
    });

    it('handles multiple numbers concatenated with colons or delimiters', () => {
      const input = '+1 555-765-4321 ::: (555) 765-4322 ::: +15557654321';
      const result = normalizePhone(input);
      assert.equal(result.length, 2);
      assert.ok(result.includes('+15557654321'));
      assert.ok(result.includes('+15557654322'));
    });
  });

  describe('parseCubeContactString', () => {
    it('extracts name and phone prefix from truncated Cube ACR contact string', () => {
      const res = parseCubeContactString('Aunt Alice (+1 555-76');
      assert.equal(res.name, 'Aunt Alice');
      assert.equal(res.phonePrefix, '+155576');
    });

    it('extracts name and prefix from 1-prefixed numbers', () => {
      const res = parseCubeContactString('Bob (1 555-76');
      assert.equal(res.name, 'Bob');
      assert.equal(res.phonePrefix, '+155576');
    });

    it('identifies standalone phone number strings', () => {
      const res = parseCubeContactString('+1 555-234-5678');
      assert.equal(res.name, '+1 555-234-5678');
      assert.equal(res.fullPhone, '+15552345678');
    });
  });

  describe('slugifyPersonName', () => {
    it('creates deterministic, url-safe person IDs with unicode normalization', () => {
      assert.equal(slugifyPersonName('Aunt Alice'), 'person_aunt_alice');
      assert.equal(slugifyPersonName('José García'), 'person_jose_garcia');
    });
  });

  describe('Resolution & Merging', () => {
    it('contains seed relationships when passed', () => {
      const resolver = new PeopleResolver(SYNTHETIC_SEED);
      const spouse = resolver.find('Jane Doe');
      assert.ok(spouse);
      assert.equal(spouse.relationship, 'wife');
      assert.ok(spouse.phones.includes('+15552345678'));

      const mom = resolver.find('+15559876543');
      assert.ok(mom);
      assert.equal(mom.name, 'Mom Mary');
      assert.equal(mom.relationship, 'mother');

      const dad = resolver.find('+15558765432');
      assert.ok(dad);
      assert.equal(dad.relationship, 'father');

      const aunt = resolver.find('alice@example.com');
      assert.ok(aunt);
      assert.equal(aunt.name, 'Aunt Alice');
      assert.equal(aunt.notes, 'Test note only');
    });

    it('merges new contact details into seeded entity by phone', () => {
      const resolver = new PeopleResolver(SYNTHETIC_SEED);
      resolver.ingestRecord({
        source: 'contacts',
        name: 'Alice Smith Jr',
        phones: ['5557654321'],
        notes: 'Updated address',
        tags: ['austin'],
      });

      const aunt = resolver.find('person_aunt_test');
      assert.ok(aunt);
      assert.ok(aunt.aliases.includes('Alice Smith Jr'));
      assert.ok(aunt.tags.includes('austin'));
      assert.ok(aunt.notes?.includes('Test note only'));
      assert.ok(aunt.notes?.includes('Updated address'));
    });

    it('is idempotent: same itemId does not increment interactionCount', () => {
      const resolver = new PeopleResolver(SYNTHETIC_SEED);
      resolver.ingestRecord({
        source: 'cube-acr-calls',
        itemId: 'call_101',
        phones: ['5557654321'],
      });
      const count1 = resolver.find('person_aunt_test')!.interactionCount;

      resolver.ingestRecord({
        source: 'cube-acr-calls',
        itemId: 'call_101',
        phones: ['5557654321'],
      });
      const count2 = resolver.find('person_aunt_test')!.interactionCount;

      assert.equal(count1, count2);
    });

    it('handles ambiguous prefixes by intersecting with alias or rejecting auto-merge', () => {
      const resolver = new PeopleResolver(SYNTHETIC_SEED);
      // Both Aunt Alice (+15557654321) and Uncle Bob (+15557654399) share prefix +15557654
      // Record has Uncle Bob's name with the shared prefix
      const res = resolver.ingestRecord({
        source: 'cube-acr-calls',
        name: 'Uncle Bob (+1 555-7654',
      });
      assert.equal(res.id, 'person_uncle_test');

      // Ambiguous prefix with NO matching name does not auto-merge into Aunt Alice
      const unknown = resolver.ingestRecord({
        source: 'cube-acr-calls',
        name: 'Mystery Person (+1 555-7654',
      });
      assert.notEqual(unknown.id, 'person_aunt_test');
      assert.notEqual(unknown.id, 'person_uncle_test');
    });

    it('avoids ID collision when ingesting same-named unknowns', () => {
      const resolver = new PeopleResolver();
      const p1 = resolver.ingestRecord({ source: 'sms', name: 'Unknown' });
      const p2 = resolver.ingestRecord({ source: 'sms', name: 'Unknown' });
      const p3 = resolver.ingestRecord({ source: 'sms', name: 'Unknown' });

      assert.notEqual(p1.id, p2.id);
      assert.notEqual(p2.id, p3.id);
      assert.equal(resolver.getAllPeople().length, 3);
    });

    it('classifies Oakridge staff contacts as colleagues with oakridge-staff tag', () => {
      const resolver = new PeopleResolver();
      const staff = resolver.ingestRecord({
        source: 'contacts',
        name: 'Chef Oakridge',
        phones: ['+1 555-505-0231'],
        account: 'oakridge@example.com',
      });

      assert.equal(staff.relationship, 'colleague');
      assert.ok(staff.tags.includes('oakridge-staff'));
      assert.ok(staff.phones.includes('+15555050231'));
    });

    it('exports GraphEntities, GraphEdges with self node, and Ledger Events', () => {
      const resolver = new PeopleResolver(SYNTHETIC_SEED);
      const { entities, edges } = resolver.toGraphEntitiesAndEdges('person_test_operator');

      // Must include self entity
      const selfNode = entities.find((e) => e.id === 'person_test_operator');
      assert.ok(selfNode);
      assert.equal(selfNode.type, 'PERSON');

      // Edges must originate from selfNode
      assert.ok(edges.every((e) => e.sourceId === 'person_test_operator'));

      const events = resolver.toLedgerEvents('person_test_operator');
      assert.ok(events.length >= 10);
      assert.ok(events.some((ev) => ev.type === 'ENTITY_UPSERT'));
      assert.ok(events.some((ev) => ev.type === 'EDGE_UPSERT'));
    });

    it('returns defensive copies so callers cannot mutate internal state', () => {
      const resolver = new PeopleResolver(SYNTHETIC_SEED);
      const p = resolver.find('person_test_spouse')!;
      p.phones.push('+15559999999');

      const fresh = resolver.find('person_test_spouse')!;
      assert.ok(!fresh.phones.includes('+15559999999'));
    });
  });
});
