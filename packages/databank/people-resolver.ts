/**
 * @file people-resolver.ts
 * Unified People Graph Resolver for Sovereign Exocortex Databank.
 * Merges phone numbers (E.164), contact cards, Fi caller IDs, Cube truncated names,
 * and Messenger contacts into canonical Person IDs and relational graph entities.
 *
 * Invariant: Zero plaintext real-world PII or gate codes are committed to source control.
 * Canonical ground-truth seeds are loaded dynamically at runtime from external/vault files.
 */

import { readFileSync, existsSync } from 'node:fs';

export type PersonRelationship =
  | 'wife'
  | 'mother'
  | 'father'
  | 'aunt'
  | 'uncle'
  | 'child'
  | 'colleague'
  | 'family'
  | 'friend'
  | (string & {});

export interface CanonicalPerson {
  id: string;
  name: string;
  relationship?: PersonRelationship;
  aliases: string[];
  phones: string[]; // E.164 format e.g. +15551234567
  emails: string[]; // lowercase
  notes?: string;
  tags: string[];
  sourceItemIds: string[];
  lastInteractionTs?: number;
  interactionCount: number;
}

export interface RawPersonInput {
  source: string;
  itemId?: string;
  name?: string;
  phones?: string[];
  emails?: string[];
  notes?: string;
  account?: string;
  timestamp?: number;
  tags?: string[];
}

export interface GraphEntityOutput {
  id: string;
  type: 'PERSON';
  name: string;
  properties: Record<string, unknown>;
  activation: number;
  lastActive: number;
}

export interface GraphEdgeOutput {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
  observedCount: number;
  lastObserved: number;
}

/**
 * Validates and normalizes phone number strings into E.164 format.
 * Adheres to ITU-T E.164 (max 15 digits) and NANP format (+1 followed by 10 digits).
 */
export function normalizePhone(raw: string): string[] {
  if (!raw) return [];
  // Split on multi-number delimiters commonly found in Samsung/Android contacts
  const parts = raw.split(/(?:::|;|\r?\n)/);
  const out = new Set<string>();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Clean whitespace and extraneous formatting
    // If it starts with +, preserve the single leading + and strip all other non-digits
    let clean = '';
    if (trimmed.startsWith('+')) {
      clean = '+' + trimmed.slice(1).replace(/\D/g, '');
    } else {
      clean = trimmed.replace(/\D/g, '');
    }

    if (!clean) continue;

    let e164 = '';
    if (clean.startsWith('+')) {
      const digits = clean.slice(1);
      if (digits.length >= 7 && digits.length <= 15) {
        e164 = `+${digits}`;
      }
    } else if (clean.length === 10) {
      // 10-digit US number (validate NANP area code [2-9]xx and exchange [2-9]xx)
      if (/^[2-9]\d{2}[2-9]\d{6}$/.test(clean)) {
        e164 = `+1${clean}`;
      }
    } else if (clean.length === 11 && clean.startsWith('1')) {
      const sub = clean.slice(1);
      if (/^[2-9]\d{2}[2-9]\d{6}$/.test(sub)) {
        e164 = `+1${sub}`;
      }
    } else if (clean.length >= 8 && clean.length <= 15) {
      e164 = `+${clean}`;
    }

    if (e164 && e164.length <= 16) {
      out.add(e164);
    }
  }

  return [...out];
}

/**
 * Parses Cube ACR contact title strings:
 * "Aunt Pam (+1 979-56" -> { name: "Aunt Pam", phonePrefix: "+197956" }
 * "Rob Marshall (1 512" -> { name: "Rob Marshall", phonePrefix: "+1512" }
 * "+1 757-213-0747" -> { name: "+1 757-213-0747", fullPhone: "+17572130747" }
 */
export function parseCubeContactString(raw: string): { name: string; phonePrefix?: string; fullPhone?: string } {
  const clean = raw.trim();
  if (!clean) return { name: 'Unknown' };

  // Match: Name (+1 979-56 or Name (1 512 (running to end of string or unclosed paren)
  const mTrunc = clean.match(/^(.*?)\s*\(\+?(\d[\d\s\-]{3,})$/);
  if (mTrunc) {
    const name = mTrunc[1].trim() || 'Unknown';
    const digits = mTrunc[2].replace(/\D/g, '');
    const prefix = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
    return { name, phonePrefix: prefix };
  }

  // Pure standalone phone number
  const phones = normalizePhone(clean);
  if (phones.length > 0 && /^[+\d\s\-()]+$/.test(clean)) {
    return { name: clean, fullPhone: phones[0] };
  }

  return { name: clean };
}

/**
 * Normalizes names to a lowercase slug suitable for person IDs, with NFKD unicode normalization.
 */
export function slugifyPersonName(name: string): string {
  const clean = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean ? `person_${clean}` : 'person_unknown';
}

export class PeopleResolver {
  private readonly peopleById = new Map<string, CanonicalPerson>();
  private readonly byPhone = new Map<string, string>(); // E.164 -> personId
  private readonly byEmail = new Map<string, string>(); // email -> personId
  private readonly byAlias = new Map<string, string>(); // lowercase alias -> personId

  constructor(seedPersons?: Array<Omit<CanonicalPerson, 'sourceItemIds' | 'interactionCount'>>) {
    if (seedPersons && seedPersons.length > 0) {
      for (const p of seedPersons) {
        this.addPerson({
          ...p,
          sourceItemIds: ['seed:config'],
          interactionCount: 1,
        });
      }
    }
  }

  /**
   * Loads seed people configuration from an external JSON file (e.g. vault or local appdata).
   */
  public static fromFile(filePath: string): PeopleResolver {
    if (!existsSync(filePath)) {
      return new PeopleResolver();
    }
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Array.isArray(data)) {
        return new PeopleResolver(data);
      }
    } catch {
      // Fallback to empty resolver
    }
    return new PeopleResolver();
  }

  /**
   * Adds or registers a canonical person, populating lookup indices.
   * Clones arrays defensively to ensure internal immutability.
   */
  public addPerson(person: CanonicalPerson): CanonicalPerson {
    const existing = this.peopleById.get(person.id);
    if (!existing) {
      const cloned: CanonicalPerson = {
        ...person,
        aliases: [...new Set(person.aliases.map((a) => a.trim()).filter(Boolean))],
        phones: [...new Set(person.phones.flatMap(normalizePhone))],
        emails: [...new Set(person.emails.map((e) => e.toLowerCase().trim()).filter(Boolean))],
        tags: [...new Set(person.tags)],
        sourceItemIds: [...new Set(person.sourceItemIds)],
      };
      this.peopleById.set(cloned.id, cloned);
      this.indexPerson(cloned);
      return this.clonePerson(cloned);
    }

    // Merge into existing
    const mergedAliases = [...new Set([...existing.aliases, ...person.aliases.map((a) => a.trim()).filter(Boolean)])];
    const mergedPhones = [...new Set([...existing.phones, ...person.phones.flatMap(normalizePhone)])];
    const mergedEmails = [...new Set([...existing.emails, ...person.emails.map((e) => e.toLowerCase().trim()).filter(Boolean)])];
    const mergedTags = [...new Set([...existing.tags, ...person.tags])];
    const mergedSources = [...new Set([...existing.sourceItemIds, ...person.sourceItemIds])];
    const interactionCount = existing.interactionCount + person.interactionCount;
    const lastInteractionTs = Math.max(existing.lastInteractionTs ?? 0, person.lastInteractionTs ?? 0) || undefined;

    existing.aliases = mergedAliases;
    existing.phones = mergedPhones;
    existing.emails = mergedEmails;
    existing.tags = mergedTags;
    existing.sourceItemIds = mergedSources;
    existing.interactionCount = interactionCount;
    if (lastInteractionTs) existing.lastInteractionTs = lastInteractionTs;
    if (!existing.relationship && person.relationship) existing.relationship = person.relationship;

    // Append notes if distinct
    if (person.notes && person.notes !== existing.notes) {
      existing.notes = existing.notes ? `${existing.notes} | ${person.notes}` : person.notes;
    }

    this.indexPerson(existing);
    return this.clonePerson(existing);
  }

  private clonePerson(p: CanonicalPerson): CanonicalPerson {
    return {
      ...p,
      aliases: [...p.aliases],
      phones: [...p.phones],
      emails: [...p.emails],
      tags: [...p.tags],
      sourceItemIds: [...p.sourceItemIds],
    };
  }

  private indexPerson(p: CanonicalPerson): void {
    for (const ph of p.phones) {
      this.byPhone.set(ph, p.id);
    }
    for (const em of p.emails) {
      this.byEmail.set(em.toLowerCase().trim(), p.id);
    }
    for (const al of p.aliases) {
      const k = al.toLowerCase().trim();
      if (k) this.byAlias.set(k, p.id);
    }
    this.byAlias.set(p.name.toLowerCase().trim(), p.id);
  }

  /**
   * Resolves a raw record against the existing people graph.
   * If a match is found, merges new details into the canonical person.
   * If no match, creates and indexes a new canonical person.
   */
  public ingestRecord(input: RawPersonInput): CanonicalPerson {
    const rawName = (input.name ?? '').trim();
    const cubeParsed = parseCubeContactString(rawName);

    const normPhones: string[] = [];
    if (input.phones) {
      for (const p of input.phones) {
        normPhones.push(...normalizePhone(p));
      }
    }
    if (cubeParsed.fullPhone) {
      normPhones.push(...normalizePhone(cubeParsed.fullPhone));
    }

    const normEmails = (input.emails ?? []).map((e) => e.toLowerCase().trim()).filter(Boolean);

    // Check for Oakridge Smokehouse Staff classification
    const isOakridge =
      /oakridge/i.test(rawName) ||
      (input.account && /oakridge/i.test(input.account)) ||
      normEmails.some((e) => e.includes('oakridge'));

    // Attempt matching:
    // 1. By Exact Phone (E.164)
    let matchedId: string | undefined;
    for (const ph of normPhones) {
      if (this.byPhone.has(ph)) {
        matchedId = this.byPhone.get(ph);
        break;
      }
    }

    // 2. By Email
    if (!matchedId) {
      for (const em of normEmails) {
        if (this.byEmail.has(em)) {
          matchedId = this.byEmail.get(em);
          break;
        }
      }
    }

    // 3. By Exact Alias / Name (Cleaned name from Cube or input)
    const candidateName = cubeParsed.name !== 'Unknown' ? cubeParsed.name : rawName;
    if (!matchedId && candidateName) {
      const nameKey = candidateName.toLowerCase();
      if (this.byAlias.has(nameKey)) {
        matchedId = this.byAlias.get(nameKey);
      }
    }

    // 4. By Cube ACR Truncated Prefix matching (Disambiguated by candidate set and name)
    if (!matchedId && cubeParsed.phonePrefix && cubeParsed.phonePrefix.length >= 8) {
      const candidateIds = new Set<string>();
      for (const [knownPhone, pId] of this.byPhone.entries()) {
        if (knownPhone.startsWith(cubeParsed.phonePrefix)) {
          candidateIds.add(pId);
        }
      }

      const nameId = candidateName ? this.byAlias.get(candidateName.toLowerCase()) : undefined;
      if (nameId && candidateIds.has(nameId)) {
        matchedId = nameId;
      } else if (candidateIds.size === 1) {
        matchedId = [...candidateIds][0];
      }
      // If multiple candidates and name doesn't match, do not auto-merge ambiguously.
    }

    const tags = input.tags ? [...input.tags] : [];
    if (isOakridge && !tags.includes('oakridge-staff')) {
      tags.push('oakridge-staff');
    }

    // Use clean name without truncated number for alias
    const aliasToAdd = candidateName && candidateName !== 'Unknown' ? candidateName : undefined;

    if (matchedId) {
      const person = this.peopleById.get(matchedId)!;
      // Idempotency: if itemId already seen, do not increment interactionCount
      const isNewItem = input.itemId ? !person.sourceItemIds.includes(input.itemId) : true;
      const countInc = isNewItem ? 1 : 0;

      return this.addPerson({
        id: matchedId,
        name: person.name,
        aliases: aliasToAdd ? [aliasToAdd] : [],
        phones: normPhones,
        emails: normEmails,
        tags,
        sourceItemIds: input.itemId ? [input.itemId] : [],
        interactionCount: countInc,
        lastInteractionTs: input.timestamp,
        notes: input.notes,
      });
    }

    // Generate new CanonicalPerson with safe collision handling
    const primaryName = aliasToAdd || (normPhones[0] ?? normEmails[0] ?? 'Unknown Person');
    const baseId = slugifyPersonName(primaryName);
    let personId = baseId;
    let collisionIdx = 1;
    while (this.peopleById.has(personId)) {
      personId = `${baseId}_${++collisionIdx}`;
    }

    const newPerson: CanonicalPerson = {
      id: personId,
      name: primaryName,
      relationship: isOakridge ? 'colleague' : undefined,
      aliases: aliasToAdd ? [aliasToAdd] : [],
      phones: normPhones,
      emails: normEmails,
      notes: input.notes,
      tags,
      sourceItemIds: input.itemId ? [input.itemId] : [],
      interactionCount: 1,
      lastInteractionTs: input.timestamp,
    };

    return this.addPerson(newPerson);
  }

  /**
   * Look up a person by canonical ID, phone, email, or alias.
   */
  public find(query: string): CanonicalPerson | undefined {
    const q = query.trim();
    if (this.peopleById.has(q)) return this.clonePerson(this.peopleById.get(q)!);

    // E.164 phone
    const phones = normalizePhone(q);
    for (const ph of phones) {
      if (this.byPhone.has(ph)) return this.clonePerson(this.peopleById.get(this.byPhone.get(ph)!)!);
    }

    // Email
    const emKey = q.toLowerCase();
    if (this.byEmail.has(emKey)) return this.clonePerson(this.peopleById.get(this.byEmail.get(emKey)!)!);

    // Alias
    if (this.byAlias.has(emKey)) return this.clonePerson(this.peopleById.get(this.byAlias.get(emKey)!)!);

    return undefined;
  }

  /**
   * Returns defensive copies of all canonical people.
   */
  public getAllPeople(): CanonicalPerson[] {
    return [...this.peopleById.values()].map((p) => this.clonePerson(p));
  }

  /**
   * Converts canonical people into World-Model Graph Entities and Edges.
   * Includes selfId node so edges do not dangle.
   */
  public toGraphEntitiesAndEdges(selfId: string = 'person_michael'): {
    entities: GraphEntityOutput[];
    edges: GraphEdgeOutput[];
  } {
    const entities: GraphEntityOutput[] = [];
    const edges: GraphEdgeOutput[] = [];

    // Ensure self entity exists so edges do not dangle
    entities.push({
      id: selfId,
      type: 'PERSON',
      name: 'Michael Hebert (Self)',
      properties: { role: 'operator', origin: 'people-resolver-self' },
      activation: 1.0,
      lastActive: Date.now(),
    });

    const people = [...this.peopleById.values()];
    const maxInteractions = people.reduce((max, p) => Math.max(max, p.interactionCount), 1);

    for (const p of people) {
      if (p.id === selfId) continue;

      const lastActive = p.lastInteractionTs ?? 0;
      entities.push({
        id: p.id,
        type: 'PERSON',
        name: p.name,
        properties: {
          relationship: p.relationship,
          aliases: [...p.aliases],
          phones: [...p.phones],
          emails: [...p.emails],
          notes: p.notes,
          tags: [...p.tags],
          sourcesCount: p.sourceItemIds.length,
        },
        activation: Math.min(1.0, Math.max(0.1, p.interactionCount / maxInteractions)),
        lastActive,
      });

      // Edge from self to person
      const relation = p.relationship === 'wife'
        ? 'CARES_ABOUT'
        : p.relationship === 'mother' || p.relationship === 'father' || p.relationship === 'child'
          ? 'CARES_ABOUT'
          : p.relationship === 'colleague'
            ? 'WORKS_ON'
            : 'INTERACTS_WITH';

      const weight = Math.min(1.0, Math.log1p(p.interactionCount) / Math.log1p(maxInteractions));

      edges.push({
        id: `${selfId}:${relation}:${p.id}`,
        sourceId: selfId,
        targetId: p.id,
        relation,
        weight: Number(weight.toFixed(3)),
        observedCount: p.interactionCount,
        lastObserved: lastActive,
      });
    }

    return { entities, edges };
  }

  /**
   * Produces append-only ledger events for persistence into GraphStore / event logs.
   */
  public toLedgerEvents(selfId: string = 'person_michael'): Array<Record<string, unknown>> {
    const { entities, edges } = this.toGraphEntitiesAndEdges(selfId);
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();

    for (const e of entities) {
      events.push({
        ts: e.lastActive || now,
        type: 'ENTITY_UPSERT',
        entity: e,
      });
    }

    for (const ed of edges) {
      events.push({
        ts: ed.lastObserved || now,
        type: 'EDGE_UPSERT',
        edge: ed,
      });
    }

    return events;
  }
}
