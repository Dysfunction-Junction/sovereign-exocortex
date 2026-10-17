import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import {
  getFullLivingGraph,
  connectLivingGraphStream,
  getNeo4jStatus,
  triggerNeo4jSync,
  type FullLivingGraph,
  type FullGraphEntity,
  type FullGraphEdge,
  type Neo4jSyncStatusResponse,
} from "../lib/api";

const TYPE_COLORS: Record<string, string> = {
  PERSON: "#fb923c",        // Amber / Orange
  PROJECT: "#38bdf8",       // Electric Cyan
  DEVICE: "#a78bfa",        // Purple
  GOAL: "#34d399",          // Emerald Green
  ROUTINE: "#f472b6",       // Rose Pink
  CONTEXT_STATE: "#facc15",  // Gold
  TOPIC: "#2dd4bf",         // Teal
  DOC: "#94a3b8",           // Slate
  DEFAULT: "#818cf8",       // Indigo
};

function getNodeColor(type: string): string {
  return TYPE_COLORS[type.toUpperCase()] ?? TYPE_COLORS.DEFAULT;
}

interface GraphNode extends FullGraphEntity {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  color?: string;
  val?: number;
}

interface GraphLink extends FullGraphEdge {
  source: string | GraphNode;
  target: string | GraphNode;
}

export default function LivingBrain() {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraph3DInstance | null>(null);

  const [graphData, setGraphData] = useState<FullLivingGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamActive, setStreamActive] = useState(false);
  const [lastPulse, setLastPulse] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [autoRotate, setAutoRotate] = useState(true);
  const [copiedQuery, setCopiedQuery] = useState(false);
  const [neo4jStatus, setNeo4jStatus] = useState<Neo4jSyncStatusResponse | null>(null);
  const [syncingNeo4j, setSyncingNeo4j] = useState(false);

  // Load initial full snapshot
  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getFullLivingGraph();
      setGraphData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshNeo4jStatus = useCallback(async () => {
    try {
      const res = await getNeo4jStatus();
      setNeo4jStatus(res);
    } catch {
      // Quiet fail if gateway/Neo4j offline
    }
  }, []);

  useEffect(() => {
    void loadGraph();
    void refreshNeo4jStatus();
    const interval = setInterval(() => {
      void refreshNeo4jStatus();
    }, 12000);
    return () => clearInterval(interval);
  }, [loadGraph, refreshNeo4jStatus]);

  const handleTriggerNeo4jSync = async () => {
    setSyncingNeo4j(true);
    try {
      const res = await triggerNeo4jSync();
      setNeo4jStatus(res.status);
      await loadGraph();
    } catch (err) {
      console.error("Failed to sync Neo4j:", err);
    } finally {
      setSyncingNeo4j(false);
    }
  };

  // Connect live SSE streaming
  useEffect(() => {
    const unsub = connectLivingGraphStream({
      onInit: () => {
        setStreamActive(true);
      },
      onPulse: (pulse) => {
        setStreamActive(true);
        setLastPulse(`Pulse: ${pulse.kind} (${new Date(pulse.timestamp).toLocaleTimeString()})`);

        // Dynamically update node activations in memory
        if (fgRef.current && pulse.activatedEntities?.length) {
          const actMap = new Map(pulse.activatedEntities.map((e) => [e.id, e.activation ?? 0.8]));
          const currentData = fgRef.current.graphData();
          for (const node of currentData.nodes as GraphNode[]) {
            if (actMap.has(node.id)) {
              node.activation = actMap.get(node.id)!;
              node.val = 3 + node.activation * 12;
            }
          }
          // Trigger visual re-render with surge
          fgRef.current.linkDirectionalParticleSpeed(0.015);
          setTimeout(() => {
            fgRef.current?.linkDirectionalParticleSpeed(0.005);
          }, 1200);
        }
      },
      onPing: () => {
        setStreamActive(true);
      },
      onError: () => {
        setStreamActive(false);
      },
      onClose: () => {
        setStreamActive(false);
      },
    });

    return () => {
      unsub();
    };
  }, []);

  // Filtered nodes and links
  const filteredData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };

    let nodes = graphData.entities.map((e) => ({
      ...e,
      color: getNodeColor(e.type),
      val: 2.5 + (e.activation ?? 0) * 10,
    })) as GraphNode[];

    if (selectedFilter !== "ALL") {
      nodes = nodes.filter((n) => n.type.toUpperCase() === selectedFilter);
    }

    const nodeIds = new Set(nodes.map((n) => n.id));

    const links = graphData.edges
      .filter((e) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId))
      .map((e) => ({
        ...e,
        source: e.sourceId,
        target: e.targetId,
      })) as GraphLink[];

    return { nodes, links };
  }, [graphData, selectedFilter]);

  // Mount & configure ForceGraph3D
  useEffect(() => {
    if (!containerRef.current || loading) return;

    if (!fgRef.current) {
      const fg = new (ForceGraph3D as any)()(containerRef.current)
        .backgroundColor("rgba(7, 8, 14, 0.98)")
        .nodeLabel((node: GraphNode) => {
          const act = ((node.activation ?? 0) * 100).toFixed(0);
          return `<div style="background: rgba(15, 20, 35, 0.92); border: 1px solid rgba(255,255,255,0.15); padding: 8px 12px; border-radius: 8px; font-family: sans-serif; box-shadow: 0 4px 20px rgba(0,0,0,0.6);">
            <div style="font-weight: 700; color: #ffffff; font-size: 13px;">${node.name}</div>
            <div style="font-size: 11px; color: ${node.color}; margin-top: 2px; text-transform: uppercase; font-weight: 600;">${node.type}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Activation: <span style="color:#38bdf8; font-weight:700;">${act}%</span></div>
          </div>`;
        })
        .nodeThreeObject((node: GraphNode) => {
          const group = new THREE.Group();
          const radius = Math.max(2, 2 + (node.activation ?? 0) * 6);
          const color = new THREE.Color(node.color ?? getNodeColor(node.type));

          // Core Sphere
          const geometry = new THREE.SphereGeometry(radius, 16, 16);
          const material = new THREE.MeshLambertMaterial({
            color,
            transparent: true,
            opacity: 0.9,
          });
          const sphere = new THREE.Mesh(geometry, material);
          group.add(sphere);

          // Glowing Aura for active nodes
          if ((node.activation ?? 0) > 0.4) {
            const glowGeo = new THREE.SphereGeometry(radius * 1.5, 12, 12);
            const glowMat = new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: (node.activation ?? 0) * 0.25,
              wireframe: true,
            });
            const glow = new THREE.Mesh(glowGeo, glowMat);
            group.add(glow);
          }

          return group;
        })
        .linkColor(() => "rgba(99, 102, 241, 0.25)")
        .linkWidth(1.2)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.6)
        .linkDirectionalParticleSpeed(0.005)
        .linkDirectionalParticleColor(() => "#38bdf8")
        .onNodeClick((node: GraphNode) => {
          setSelectedNode(node);
          // Aim camera at node
          if (fgRef.current && node.x !== undefined && node.y !== undefined && node.z !== undefined) {
            const distance = 80;
            const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
            fgRef.current.cameraPosition(
              { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
              node as any,
              1200
            );
          }
        });

      fgRef.current = fg;
    }

    const fg = fgRef.current;
    if (!fg) return;
    fg.graphData(filteredData);
    const controls = fg.controls() as any;
    if (controls) {
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.6;
    }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect && fgRef.current) {
          fgRef.current.width(entry.contentRect.width);
          fgRef.current.height(entry.contentRect.height);
        }
      }
    });

    if (containerRef.current) {
      ro.observe(containerRef.current);
    }

    return () => {
      ro.disconnect();
    };
  }, [filteredData, loading, autoRotate]);

  // Clean up WebGL on component unmount
  useEffect(() => {
    return () => {
      if (fgRef.current) {
        try {
          (fgRef.current as any)._destructor?.();
        } catch {
          // ignore
        }
        fgRef.current = null;
      }
    };
  }, []);

  // Search handler
  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (!q.trim() || !fgRef.current) return;

    const match = filteredData.nodes.find(
      (n) => n.name.toLowerCase().includes(q.toLowerCase()) || n.id.toLowerCase().includes(q.toLowerCase())
    );

    if (match && match.x !== undefined && match.y !== undefined && match.z !== undefined) {
      setSelectedNode(match);
      const distance = 70;
      const distRatio = 1 + distance / Math.hypot(match.x, match.y, match.z);
      fgRef.current.cameraPosition(
        { x: match.x * distRatio, y: match.y * distRatio, z: match.z * distRatio },
        match as any,
        1000
      );
    }
  };

  // Neo4j Cypher copy
  const cypherQuery = useMemo(() => {
    if (!selectedNode) return "";
    return `MATCH (n:Entity {id: "${selectedNode.id}"})-[r]-(m)\nRETURN n, r, m\nLIMIT 50;`;
  }, [selectedNode]);

  const handleCopyCypher = () => {
    if (!cypherQuery) return;
    void navigator.clipboard.writeText(cypherQuery);
    setCopiedQuery(true);
    setTimeout(() => setCopiedQuery(false), 2000);
  };

  const categories = ["ALL", "PROJECT", "PERSON", "GOAL", "DEVICE", "ROUTINE", "TOPIC"];

  return (
    <div style={{ position: "relative", width: "100%", height: "calc(100svh - 110px)", minHeight: "650px", overflow: "hidden", background: "#07080e" }}>
      {/* 3D WebGL Canvas Container */}
      <div ref={containerRef} style={{ width: "100%", height: "100%", outline: "none" }} />

      {/* Top Floating Control Bar */}
      <div style={{
        position: "absolute",
        top: 16,
        left: 20,
        right: 20,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        pointerEvents: "none",
        zIndex: 10,
      }}>
        {/* Left: Status & Meta */}
        <div style={{
          pointerEvents: "auto",
          background: "rgba(13, 17, 30, 0.85)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          borderRadius: "14px",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: streamActive ? "#10b981" : "#f59e0b",
                boxShadow: streamActive ? "0 0 10px #10b981" : "none",
              }} />
              <span style={{ fontSize: "14px", fontWeight: 700, color: "#ffffff" }}>Living Brain 3D</span>
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: 2 }}>
              {graphData ? `${graphData.entityCount} nodes · ${graphData.edgeCount} synapses` : "Connecting..."}
            </div>
          </div>

          {graphData && (
            <span style={{
              fontSize: "11px",
              fontWeight: 700,
              padding: "3px 8px",
              borderRadius: "10px",
              background: "rgba(99, 102, 241, 0.2)",
              color: "#a5b4fc",
              textTransform: "uppercase",
            }}>
              {graphData.cognitiveMode}
            </span>
          )}

          {lastPulse && (
            <span style={{ fontSize: "11px", color: "#38bdf8", fontWeight: 600 }}>
              {lastPulse}
            </span>
          )}

          {/* Neo4j Continuous Sync Badge */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: neo4jStatus?.connected ? "rgba(16, 185, 129, 0.12)" : "rgba(148, 163, 184, 0.12)",
            border: `1px solid ${neo4jStatus?.connected ? "rgba(16, 185, 129, 0.3)" : "rgba(148, 163, 184, 0.2)"}`,
            borderRadius: "10px",
            padding: "3px 8px",
            fontSize: "11px",
            fontWeight: 600,
            color: neo4jStatus?.connected ? "#34d399" : "#94a3b8",
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: neo4jStatus?.connected ? "#10b981" : "#64748b",
              boxShadow: neo4jStatus?.connected ? "0 0 6px #10b981" : "none",
            }} />
            <span>
              {neo4jStatus?.connected
                ? `Neo4j: ${neo4jStatus.nodeCount} nodes`
                : "Neo4j Offline"}
            </span>
            <button
              type="button"
              onClick={handleTriggerNeo4jSync}
              disabled={syncingNeo4j}
              title="Force sync to Neo4j"
              style={{
                background: "transparent",
                border: "none",
                color: syncingNeo4j ? "#38bdf8" : "#94a3b8",
                cursor: "pointer",
                padding: "0 2px",
                fontSize: "12px",
                lineHeight: 1,
              }}
            >
              {syncingNeo4j ? "…" : "↻"}
            </button>
          </div>
        </div>

        {/* Right: Controls & Search */}
        <div style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}>
          {/* Search Input */}
          <input
            type="text"
            placeholder="Search neuron / entity..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            style={{
              background: "rgba(13, 17, 30, 0.85)",
              backdropFilter: "blur(16px)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: "12px",
              padding: "8px 14px",
              color: "#ffffff",
              fontSize: "13px",
              outline: "none",
              width: "200px",
            }}
          />

          {/* Auto Rotate Toggle */}
          <button
            type="button"
            onClick={() => setAutoRotate(!autoRotate)}
            style={{
              background: autoRotate ? "rgba(99, 102, 241, 0.3)" : "rgba(13, 17, 30, 0.85)",
              backdropFilter: "blur(16px)",
              border: `1px solid ${autoRotate ? "rgba(99, 102, 241, 0.6)" : "rgba(255, 255, 255, 0.1)"}`,
              borderRadius: "12px",
              padding: "8px 12px",
              color: autoRotate ? "#a5b4fc" : "#94a3b8",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {autoRotate ? "Orbiting" : "Orbit"}
          </button>

          {/* Reset Camera */}
          <button
            type="button"
            onClick={() => {
              fgRef.current?.cameraPosition({ x: 0, y: 0, z: 220 }, { x: 0, y: 0, z: 0 }, 1000);
              setSelectedNode(null);
            }}
            style={{
              background: "rgba(13, 17, 30, 0.85)",
              backdropFilter: "blur(16px)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: "12px",
              padding: "8px 12px",
              color: "#94a3b8",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reset View
          </button>
        </div>
      </div>

      {/* Bottom Category Filter Chips */}
      <div style={{
        position: "absolute",
        bottom: 24,
        left: 20,
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        zIndex: 10,
      }}>
        {categories.map((cat) => {
          const isActive = selectedFilter === cat;
          const color = cat === "ALL" ? "#ffffff" : getNodeColor(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedFilter(cat)}
              style={{
                background: isActive ? `${color}25` : "rgba(13, 17, 30, 0.75)",
                backdropFilter: "blur(12px)",
                border: `1px solid ${isActive ? color : "rgba(255, 255, 255, 0.08)"}`,
                color: isActive ? color : "#94a3b8",
                fontSize: "11px",
                fontWeight: 700,
                padding: "5px 12px",
                borderRadius: "20px",
                cursor: "pointer",
                transition: "all 180ms ease",
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

      {/* Loading & Error States */}
      {loading && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          color: "#94a3b8",
        }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#ffffff", marginBottom: 8 }}>
            Initializing Living Brain...
          </div>
          <div style={{ fontSize: "12px" }}>Loading neural topology and active synapses...</div>
        </div>
      )}

      {error && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "rgba(244, 63, 94, 0.15)",
          border: "1px solid rgba(244, 63, 94, 0.4)",
          padding: "20px",
          borderRadius: "16px",
          textAlign: "center",
          maxWidth: "400px",
        }}>
          <div style={{ color: "#f43f5e", fontWeight: 700, marginBottom: 8 }}>Connection Error</div>
          <div style={{ color: "#f8fafc", fontSize: "12px", marginBottom: 14 }}>{error}</div>
          <button
            type="button"
            onClick={() => void loadGraph()}
            className="secondary pill"
            style={{ fontSize: "12px", padding: "6px 14px" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Node Inspector Drawer */}
      {selectedNode && (
        <div style={{
          position: "absolute",
          top: 80,
          right: 20,
          width: "320px",
          maxHeight: "calc(100% - 120px)",
          overflowY: "auto",
          background: "rgba(13, 17, 30, 0.92)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: "18px",
          padding: "20px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.7)",
          zIndex: 20,
          animation: "page-fade-in 200ms ease",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <span style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: "8px",
                background: `${selectedNode.color}25`,
                color: selectedNode.color,
                textTransform: "uppercase",
              }}>
                {selectedNode.type}
              </span>
              <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#ffffff", marginTop: 6, margin: 0 }}>
                {selectedNode.name}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "#64748b",
                cursor: "pointer",
                fontSize: "18px",
                padding: "2px 6px",
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "monospace", marginBottom: 14 }}>
            {selectedNode.id}
          </div>

          {/* Activation Level Meter */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: 4 }}>
              <span style={{ color: "var(--text-muted)" }}>Spreading Activation</span>
              <span style={{ color: "#38bdf8", fontWeight: 700 }}>
                {((selectedNode.activation ?? 0) * 100).toFixed(1)}%
              </span>
            </div>
            <div style={{ width: "100%", height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                width: `${Math.min(100, (selectedNode.activation ?? 0) * 100)}%`,
                height: "100%",
                background: selectedNode.color,
                borderRadius: 3,
                boxShadow: `0 0 8px ${selectedNode.color}`,
              }} />
            </div>
          </div>

          {/* Neo4j Deep Inspection Panel */}
          <div style={{
            background: "rgba(99, 102, 241, 0.08)",
            border: "1px solid rgba(99, 102, 241, 0.2)",
            borderRadius: "12px",
            padding: "12px",
            marginTop: 14,
          }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#ffffff", marginBottom: 4 }}>
              Neo4j Query Integration
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: 8 }}>
              Query this node's full subgraph in Neo4j Desktop:
            </div>
            <pre style={{
              background: "rgba(0,0,0,0.4)",
              padding: "8px",
              borderRadius: "8px",
              fontSize: "10px",
              color: "#38bdf8",
              fontFamily: "monospace",
              overflowX: "auto",
              margin: "0 0 10px 0",
            }}>
              {cypherQuery}
            </pre>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <a
                href={`http://127.0.0.1:7474/browser/?cmd=edit&arg=${encodeURIComponent(cypherQuery)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  textAlign: "center",
                  textDecoration: "none",
                  background: "rgba(16, 185, 129, 0.2)",
                  border: "1px solid rgba(16, 185, 129, 0.4)",
                  color: "#34d399",
                  padding: "7px 10px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 160ms ease",
                }}
              >
                ↗ Open in Neo4j Browser
              </a>
              <button
                type="button"
                onClick={handleCopyCypher}
                style={{
                  width: "100%",
                  background: copiedQuery ? "#10b981" : "rgba(99, 102, 241, 0.3)",
                  border: `1px solid ${copiedQuery ? "#10b981" : "rgba(99, 102, 241, 0.5)"}`,
                  color: "#ffffff",
                  padding: "6px 10px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 160ms ease",
                }}
              >
                {copiedQuery ? "✓ Copied to Clipboard" : "Copy Cypher Query"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
