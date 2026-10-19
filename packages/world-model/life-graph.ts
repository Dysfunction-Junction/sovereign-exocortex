/**
 * @file life-graph.ts
 * Pillar 1 of the Magic Piece: The Living Life Graph & Generative World Model.
 * 
 * Provides an in-memory, multi-relational causal semantic graph of the user's
 * entities, projects, obligations, routines, hardware nodes, and cognitive states.
 * Incorporates continuous energy decay dynamics, activation spreading, and
 * predictive Markovian state transition distributions.
 */

export type EntityType =
  | 'PERSON'
  | 'PROJECT'
  | 'DEVICE'
  | 'LOCATION'
  | 'GOAL'
  | 'ROUTINE'
  | 'CONTEXT_STATE'
  | 'TOPIC'
  | 'DOC'
  | 'TASK'
  | 'INTENT';

export type RelationType =
  | 'WORKS_ON'
  | 'DEPENDS_ON'
  | 'LOCATED_AT'
  | 'TRIGGERS'
  | 'BLOCKS'
  | 'CARES_ABOUT'
  | 'INTERACTS_WITH'
  | 'TRANSITIONS_TO'
  | 'HAS_TOPIC'
  | 'REFERENCES'
  | 'MENTIONS';

export interface GraphEntity {
  id: string;
  type: EntityType;
  name: string;
  properties?: Record<string, unknown>;
  activation: number; // 0.0 to 1.0 (current cognitive salience)
  lastActive: number; // epoch ms
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: RelationType;
  weight: number; // 0.0 to 1.0
  observedCount: number;
  lastObserved: number; // epoch ms
  halfLifeDays?: number; // default 30
}

export interface StatePrediction {
  predictedId: string;
  name: string;
  probability: number;
  relation: RelationType;
}

export class LivingLifeGraph {
  private entities = new Map<string, GraphEntity>();
  private edges = new Map<string, GraphEdge>();
  private adjacency = new Map<string, Set<string>>(); // sourceId -> Set<edgeId>
  private reverseAdjacency = new Map<string, Set<string>>(); // targetId -> Set<edgeId>
  // Time up to which decay has already been applied, so repeated decay() calls don't compound.
  private decayedAt = new WeakMap<object, number>();

  /**
   * Add or update an entity in the graph.
   */
  public addEntity(entity: Omit<GraphEntity, 'activation' | 'lastActive'> & Partial<Pick<GraphEntity, 'activation' | 'lastActive'>>): GraphEntity {
    const existing = this.entities.get(entity.id);
    const rawAct = entity.activation ?? existing?.activation ?? 1.0;
    const activation = typeof rawAct === 'number' && Number.isFinite(rawAct)
      ? Math.min(1.0, Math.max(0.0, rawAct))
      : (existing?.activation ?? 1.0);
    const rawLast = entity.lastActive ?? Date.now();
    const lastActive = typeof rawLast === 'number' && Number.isFinite(rawLast) && rawLast >= 0
      ? rawLast
      : Date.now();

    const updated: GraphEntity = {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      properties: { ...(existing?.properties ?? {}), ...(entity.properties ?? {}) },
      activation,
      lastActive,
    };
    this.entities.set(entity.id, updated);
    if (!this.adjacency.has(entity.id)) {
      this.adjacency.set(entity.id, new Set());
    }
    if (!this.reverseAdjacency.has(entity.id)) {
      this.reverseAdjacency.set(entity.id, new Set());
    }
    return updated;
  }

  /**
   * Retrieve an entity by id.
   */
  public getEntity(id: string): GraphEntity | undefined {
    return this.entities.get(id);
  }

  /**
   * Retrieve an edge by id.
   */
  public getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  /**
   * Add or strengthen a relational edge between two entities.
   */
  public addEdge(
    sourceId: string,
    targetId: string,
    relation: RelationType,
    weight: number = 1.0,
    halfLifeDays: number = 30
  ): GraphEdge {
    if (!this.entities.has(sourceId)) {
      throw new Error(`Source entity not found in LifeGraph: ${sourceId}`);
    }
    if (!this.entities.has(targetId)) {
      throw new Error(`Target entity not found in LifeGraph: ${targetId}`);
    }

    // Validate numeric inputs: NaN/negative weights or non-positive half-lives corrupt decay and ranking
    weight = Number.isNaN(weight) ? 0 : Math.min(1.0, Math.max(0, weight));
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) halfLifeDays = 30;

    const edgeId = `${sourceId}:${relation}:${targetId}`;
    const existing = this.edges.get(edgeId);

    const updated: GraphEdge = {
      id: edgeId,
      sourceId,
      targetId,
      relation,
      weight: existing ? Math.min(1.0, existing.weight * 0.9 + weight * 0.1 + 0.05) : Math.min(1.0, weight),
      observedCount: (existing?.observedCount ?? 0) + 1,
      lastObserved: Date.now(),
      halfLifeDays,
    };

    this.edges.set(edgeId, updated);
    this.adjacency.get(sourceId)?.add(edgeId);
    this.reverseAdjacency.get(targetId)?.add(edgeId);

    return updated;
  }

  /**
   * Stimulate an entity, boosting its activation to 1.0 and updating lastActive.
   */
  public stimulate(entityId: string, amount: number = 0.5, observedAt: number = Date.now()): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    const validAmount = typeof amount === "number" && Number.isFinite(amount) ? amount : 0.5;
    const validObservedAt = typeof observedAt === "number" && Number.isFinite(observedAt) && observedAt >= 0
      ? observedAt
      : Date.now();
    entity.activation = Math.min(1.0, Math.max(0.0, entity.activation + validAmount));
    entity.lastActive = Math.max(validObservedAt, this.decayedAt.get(entity) ?? -Infinity);
    this.decayedAt.delete(entity);
  }

  /**
   * Apply exponential decay to all entity activations and edge weights based on elapsed time.
   */
  public decay(currentTime: number = Date.now()): void {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    for (const entity of this.entities.values()) {
      const base = Math.max(entity.lastActive, this.decayedAt.get(entity) ?? -Infinity);
      const elapsedDays = (currentTime - base) / MS_PER_DAY;
      if (elapsedDays > 0) {
        this.decayedAt.set(entity, currentTime);
        // Base entity activation half-life is 7 days
        const halfLife = 7;
        const decayFactor = Math.pow(0.5, elapsedDays / halfLife);
        entity.activation = Math.max(0.01, entity.activation * decayFactor);
      }
    }

    for (const edge of this.edges.values()) {
      const base = Math.max(edge.lastObserved, this.decayedAt.get(edge) ?? -Infinity);
      const elapsedDays = (currentTime - base) / MS_PER_DAY;
      if (elapsedDays > 0) {
        this.decayedAt.set(edge, currentTime);
        const halfLife = edge.halfLifeDays ?? 30;
        const decayFactor = Math.pow(0.5, elapsedDays / halfLife);
        edge.weight = Math.max(0.01, edge.weight * decayFactor);
      }
    }
  }

  /**
   * Spreading Activation Algorithm:
   * Radiates energy from active nodes across weighted edges to find associated context.
   */
  public spreadActivation(
    sourceIds: string[],
    initialEnergy: number = 1.0,
    retentionRate: number = 0.6,
    depthLimit: number = 3,
    edgeVisitBudget: number = Infinity,
  ): Map<string, number> {
    const safeEnergy = typeof initialEnergy === "number" && Number.isFinite(initialEnergy)
      ? Math.min(1.0, Math.max(0.0, initialEnergy))
      : 1.0;
    const safeRetention = typeof retentionRate === "number" && Number.isFinite(retentionRate)
      ? Math.min(1.0, Math.max(0.0, retentionRate))
      : 0.6;
    const safeDepth = typeof depthLimit === "number" && Number.isFinite(depthLimit)
      ? Math.min(10, Math.max(0, Math.floor(depthLimit)))
      : 3;
    const safeBudget = typeof edgeVisitBudget === "number" && Number.isFinite(edgeVisitBudget) && edgeVisitBudget >= 0
      ? edgeVisitBudget
      : Infinity;

    const activationLevels = new Map<string, number>();
    const queue: Array<{ id: string; energy: number; depth: number }> = [];

    for (const id of sourceIds) {
      if (this.entities.has(id)) {
        activationLevels.set(id, safeEnergy);
        queue.push({ id, energy: safeEnergy, depth: 0 });
      }
    }

    let cursor = 0;
    let edgeVisits = 0;
    while (cursor < queue.length && edgeVisits < safeBudget) {
      const current = queue[cursor++];
      if (current.depth >= safeDepth || current.energy < 0.05) continue;

      const outgoingEdgeIds = this.adjacency.get(current.id) || new Set();
      for (const edgeId of outgoingEdgeIds) {
        if (edgeVisits >= safeBudget) break;
        edgeVisits++;
        const edge = this.edges.get(edgeId);
        if (!edge) continue;

        const transferredEnergy = current.energy * edge.weight * safeRetention;
        const targetId = edge.targetId;
        const prevLevel = activationLevels.get(targetId) ?? 0;
        const newLevel = Math.min(1.0, prevLevel + transferredEnergy);

        activationLevels.set(targetId, newLevel);
        queue.push({ id: targetId, energy: transferredEnergy, depth: current.depth + 1 });
      }
    }

    return activationLevels;
  }

  /**
   * Spreading Activation alias.
   */
  public spreadingActivation(
    sourceIds: string[],
    initialEnergy: number = 1.0,
    retentionRate: number = 0.6,
    depthLimit: number = 3,
    edgeVisitBudget: number = Infinity,
  ): Map<string, number> {
    return this.spreadActivation(sourceIds, initialEnergy, retentionRate, depthLimit, edgeVisitBudget);
  }

  /**
   * Get direct target neighbor entities for a given entity.
   */
  public getNeighbors(entityId: string): GraphEntity[] {
    const outgoing = this.adjacency.get(entityId) ?? new Set();
    const neighbors: GraphEntity[] = [];
    for (const edgeId of outgoing) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;
      const target = this.entities.get(edge.targetId);
      if (target) neighbors.push(target);
    }
    return neighbors;
  }

  /**
   * Extract the contextual subgraph around active entities up to maxHops.
   */
  public queryContextSubgraph(
    seedEntityIds: string[],
    maxHops: number = 2,
    minWeightThreshold: number = 0.1
  ): { entities: GraphEntity[]; edges: GraphEdge[] } {
    const safeHops = typeof maxHops === "number" && Number.isFinite(maxHops) && maxHops >= 0
      ? Math.min(10, Math.floor(maxHops))
      : 2;
    const safeMinWeight = typeof minWeightThreshold === "number" && Number.isFinite(minWeightThreshold)
      ? Math.max(0.0, minWeightThreshold)
      : 0.1;

    const visitedEntities = new Set<string>();
    const matchedEdges = new Set<string>();
    const queue: Array<{ id: string; hop: number }> = [];

    for (const id of seedEntityIds) {
      if (this.entities.has(id)) {
        visitedEntities.add(id);
        queue.push({ id, hop: 0 });
      }
    }

    while (queue.length > 0) {
      const { id, hop } = queue.shift()!;
      if (hop >= safeHops) continue;

      const outgoing = this.adjacency.get(id) ?? new Set();
      for (const edgeId of outgoing) {
        const edge = this.edges.get(edgeId);
        if (!edge || edge.weight < safeMinWeight) continue;

        matchedEdges.add(edge.id);
        if (!visitedEntities.has(edge.targetId)) {
          visitedEntities.add(edge.targetId);
          queue.push({ id: edge.targetId, hop: hop + 1 });
        }
      }
    }

    return {
      entities: Array.from(visitedEntities).map(id => this.entities.get(id)!),
      edges: Array.from(matchedEdges).map(id => this.edges.get(id)!),
    };
  }

  /**
   * Generative Transition Prediction:
   * Given the current active entity/state, compute the transition probability
   * distribution over subsequent states (e.g. routines, tasks, next projects).
   */
  public predictNextState(currentEntityId: string): StatePrediction[] {
    const outgoing = this.adjacency.get(currentEntityId);
    if (!outgoing || outgoing.size === 0) return [];

    const candidates: Array<{ edge: GraphEdge; entity: GraphEntity; score: number }> = [];
    let totalScore = 0;

    for (const edgeId of outgoing) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;
      const target = this.entities.get(edge.targetId);
      if (!target || !Number.isFinite(target.activation) || target.activation <= 0) continue;

      // Score combines edge transition weight, observation count, and target entity base activation
      const score = edge.weight * Math.log1p(Math.max(0, edge.observedCount)) * target.activation;
      if (Number.isFinite(score) && score > 0) {
        candidates.push({ edge, entity: target, score });
        totalScore += score;
      }
    }

    if (totalScore === 0) return [];

    return candidates
      .map(c => ({
        predictedId: c.entity.id,
        name: c.entity.name,
        probability: Math.round((c.score / totalScore) * 1000) / 1000,
        relation: c.edge.relation,
      }))
      .sort((a, b) => b.probability - a.probability);
  }

  /**
   * Total entity count.
   */
  public get entityCount(): number {
    return this.entities.size;
  }

  /**
   * Total edge count.
   */
  public get edgeCount(): number {
    return this.edges.size;
  }

  /** Return a detached snapshot of the complete graph for export and persistence. */
  public snapshot(): { entities: GraphEntity[]; edges: GraphEdge[] } {
    return {
      entities: [...this.entities.values()].map((entity) => ({
        ...entity,
        ...(entity.properties ? { properties: structuredClone(entity.properties) } : {}),
      })),
      edges: [...this.edges.values()].map((edge) => ({ ...edge })),
    };
  }
}
