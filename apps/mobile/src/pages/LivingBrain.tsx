import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import {
  getFullLivingGraph,
  connectLivingGraphStream,
  getNeo4jStatus,
  triggerNeo4jSync,
  getNeo4jAnalytics,
  queryNeo4jLivingGraph,
  type FullLivingGraph,
  type FullGraphEntity,
  type FullGraphEdge,
  type Neo4jSyncStatusResponse,
  type GraphAnalyticsResponse,
  type GraphQueryResponse,
} from "../lib/api";
import {
  playActionPotential,
  playSynapticCascade,
  playLateralInhibitionRelax,
  isSynapticAudioEnabled,
  setSynapticAudioEnabled,
} from "../lib/synapticAudio";

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
  const [analytics, setAnalytics] = useState<GraphAnalyticsResponse["analytics"] | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [nlQueryInput, setNlQueryInput] = useState("");
  const [nlQueryMode, setNlQueryMode] = useState<"nl" | "cypher">("nl");
  const [nlQueryRunning, setNlQueryRunning] = useState(false);
  const [nlQueryResult, setNlQueryResult] = useState<GraphQueryResponse["result"] | null>(null);
  const [nlQueryError, setNlQueryError] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [hideFloatingOrphans, setHideFloatingOrphans] = useState(true);

  useEffect(() => {
    isSynapticAudioEnabled().then(setAudioEnabled).catch(() => {});
  }, []);

  const toggleAudio = async () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    await setSynapticAudioEnabled(next);
  };

  const selectedNodeRef = useRef<GraphNode | null>(null);
  selectedNodeRef.current = selectedNode;

  // 2-Hop Synaptic Subgroup & Circuit Calculation
  const synapticCircuit = useMemo(() => {
    if (!selectedNode || !graphData) {
      return {
        hop1NodeIds: new Set<string>(),
        hop2NodeIds: new Set<string>(),
        activeNodeIds: new Set<string>(),
        hop1EdgeIds: new Set<string>(),
        hop2EdgeIds: new Set<string>(),
        activeEdgeIds: new Set<string>(),
      };
    }

    const selId = selectedNode.id;
    const hop1NodeIds = new Set<string>();
    const hop1EdgeIds = new Set<string>();

    // 1-Hop: Direct neighbors & incident edges
    for (const edge of graphData.edges) {
      if (edge.sourceId === selId) {
        hop1NodeIds.add(edge.targetId);
        hop1EdgeIds.add(edge.id);
      } else if (edge.targetId === selId) {
        hop1NodeIds.add(edge.sourceId);
        hop1EdgeIds.add(edge.id);
      }
    }

    // 2-Hop: Neighbors of 1-hop nodes
    const hop2NodeIds = new Set<string>();
    const hop2EdgeIds = new Set<string>();

    for (const edge of graphData.edges) {
      const sInHop1 = hop1NodeIds.has(edge.sourceId);
      const tInHop1 = hop1NodeIds.has(edge.targetId);

      if (sInHop1 && edge.targetId !== selId && !hop1NodeIds.has(edge.targetId)) {
        hop2NodeIds.add(edge.targetId);
        hop2EdgeIds.add(edge.id);
      } else if (tInHop1 && edge.sourceId !== selId && !hop1NodeIds.has(edge.sourceId)) {
        hop2NodeIds.add(edge.sourceId);
        hop2EdgeIds.add(edge.id);
      } else if (sInHop1 && tInHop1) {
        // Cross-connections within the 1-hop cluster
        hop1EdgeIds.add(edge.id);
      }
    }

    const activeNodeIds = new Set<string>([selId, ...hop1NodeIds, ...hop2NodeIds]);
    const activeEdgeIds = new Set<string>([...hop1EdgeIds, ...hop2EdgeIds]);

    return {
      hop1NodeIds,
      hop2NodeIds,
      activeNodeIds,
      hop1EdgeIds,
      hop2EdgeIds,
      activeEdgeIds,
    };
  }, [selectedNode, graphData]);

  const synapticCircuitRef = useRef(synapticCircuit);
  synapticCircuitRef.current = synapticCircuit;

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);

    // Procedural bio-electrical cascade audio
    void playActionPotential(1.0);
    void playSynapticCascade(1);
    setTimeout(() => {
      void playSynapticCascade(2);
    }, 110);

    if (fgRef.current && node.x !== undefined && node.y !== undefined && node.z !== undefined) {
      const distance = 85;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
      fgRef.current.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        node as any,
        1200
      );
    }
  }, []);

  const handleDeselect = useCallback(() => {
    setSelectedNode((prev) => {
      if (prev) {
        void playLateralInhibitionRelax();
      }
      return null;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleDeselect();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDeselect]);

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

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const res = await getNeo4jAnalytics();
      setAnalytics(res.analytics);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to load Neo4j analytics:", msg);
      setAnalyticsError(msg);
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  const handleRunNlQuery = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!nlQueryInput.trim()) return;
    setNlQueryRunning(true);
    setNlQueryError(null);
    try {
      const res = await queryNeo4jLivingGraph(nlQueryInput, nlQueryMode);
      setNlQueryResult(res.result);
      if (res.result.matchedEntityIds.length > 0 && graphData) {
        const firstId = res.result.matchedEntityIds[0];
        const match = graphData.entities.find((ent) => ent.id === firstId);
        if (match) {
          handleNodeClick(match as GraphNode);
        }
      }
    } catch (err) {
      setNlQueryError(err instanceof Error ? err.message : String(err));
    } finally {
      setNlQueryRunning(false);
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

    if (hideFloatingOrphans) {
      const connectedNodeIds = new Set<string>();
      for (const edge of graphData.edges) {
        connectedNodeIds.add(edge.sourceId);
        connectedNodeIds.add(edge.targetId);
      }
      nodes = nodes.filter((n) => n.type !== "DOC" || connectedNodeIds.has(n.id));
    }

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
  }, [graphData, selectedFilter, hideFloatingOrphans]);

  // Mount & configure ForceGraph3D
  useEffect(() => {
    if (!containerRef.current || loading) return;

    if (!fgRef.current) {
      const fg = new (ForceGraph3D as any)()(containerRef.current)
        .backgroundColor("rgba(7, 8, 14, 0.98)")
        .nodeLabel((node: GraphNode) => {
          const act = ((node.activation ?? 0) * 100).toFixed(0);
          const selNode = selectedNodeRef.current;
          const circuit = synapticCircuitRef.current;
          let roleBadge = "";
          if (selNode) {
            if (node.id === selNode.id) {
              roleBadge = `<div style="font-size: 10px; color: #38bdf8; font-weight: 700; margin-top: 2px; text-transform: uppercase;">⚡ Active Initiator</div>`;
            } else if (circuit.hop1NodeIds.has(node.id)) {
              roleBadge = `<div style="font-size: 10px; color: #38bdf8; font-weight: 600; margin-top: 2px; text-transform: uppercase;">1-Hop Synaptic Partner</div>`;
            } else if (circuit.hop2NodeIds.has(node.id)) {
              roleBadge = `<div style="font-size: 10px; color: #a78bfa; font-weight: 600; margin-top: 2px; text-transform: uppercase;">2-Hop Cascade Leaf</div>`;
            } else {
              roleBadge = `<div style="font-size: 10px; color: #64748b; margin-top: 2px; font-style: italic;">Inhibited Peripheral</div>`;
            }
          }
          return `<div style="background: rgba(15, 20, 35, 0.94); border: 1px solid rgba(255,255,255,0.15); padding: 8px 12px; border-radius: 8px; font-family: sans-serif; box-shadow: 0 4px 20px rgba(0,0,0,0.6);">
            <div style="font-weight: 700; color: #ffffff; font-size: 13px;">${node.name}</div>
            <div style="font-size: 11px; color: ${node.color}; margin-top: 2px; text-transform: uppercase; font-weight: 600;">${node.type}</div>
            ${roleBadge}
            <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Activation: <span style="color:#38bdf8; font-weight:700;">${act}%</span></div>
          </div>`;
        })
        .nodeThreeObject((node: GraphNode) => {
          const group = new THREE.Group();
          const selNode = selectedNodeRef.current;
          const circuit = synapticCircuitRef.current;
          const act = node.activation ?? 0;
          const baseColor = new THREE.Color(node.color ?? getNodeColor(node.type));

          const isSelected = Boolean(selNode && selNode.id === node.id);
          const isHop1 = Boolean(selNode && circuit.hop1NodeIds.has(node.id));
          const isHop2 = Boolean(selNode && circuit.hop2NodeIds.has(node.id));
          const isInhibited = Boolean(selNode && !isSelected && !isHop1 && !isHop2);

          if (isInhibited) {
            // Lateral Inhibition: dormant, faded, tiny slate core
            const geom = new THREE.SphereGeometry(1.2, 8, 8);
            const mat = new THREE.MeshBasicMaterial({
              color: 0x1e293b,
              transparent: true,
              opacity: 0.10,
            });
            group.add(new THREE.Mesh(geom, mat));
            return group;
          }

          if (isSelected) {
            // Initiator Neuron: action potential focal point
            const radius = Math.max(5.0, 5.0 + act * 7);
            const geom = new THREE.SphereGeometry(radius, 24, 24);
            const mat = new THREE.MeshLambertMaterial({
              color: baseColor,
              emissive: baseColor,
              emissiveIntensity: 0.8,
              transparent: true,
              opacity: 1.0,
            });
            group.add(new THREE.Mesh(geom, mat));

            // Inner Bioluminescent Aura
            const innerGlowGeo = new THREE.SphereGeometry(radius * 1.5, 16, 16);
            const innerGlowMat = new THREE.MeshBasicMaterial({
              color: 0x38bdf8,
              transparent: true,
              opacity: 0.5,
              wireframe: true,
            });
            group.add(new THREE.Mesh(innerGlowGeo, innerGlowMat));

            // Outer Pulsing Halo
            const outerHaloGeo = new THREE.SphereGeometry(radius * 2.2, 12, 12);
            const outerHaloMat = new THREE.MeshBasicMaterial({
              color: baseColor,
              transparent: true,
              opacity: 0.25,
              wireframe: true,
            });
            group.add(new THREE.Mesh(outerHaloGeo, outerHaloMat));
            return group;
          }

          if (isHop1) {
            // 1-Hop Primary Branch: vibrant, high conductance
            const radius = Math.max(3.4, 3.4 + act * 6);
            const geom = new THREE.SphereGeometry(radius, 18, 18);
            const mat = new THREE.MeshLambertMaterial({
              color: baseColor,
              emissive: baseColor,
              emissiveIntensity: 0.4,
              transparent: true,
              opacity: 0.95,
            });
            group.add(new THREE.Mesh(geom, mat));

            const glowGeo = new THREE.SphereGeometry(radius * 1.4, 12, 12);
            const glowMat = new THREE.MeshBasicMaterial({
              color: 0x38bdf8,
              transparent: true,
              opacity: 0.35,
              wireframe: true,
            });
            group.add(new THREE.Mesh(glowGeo, glowMat));
            return group;
          }

          if (isHop2) {
            // 2-Hop Secondary Cascade: medium presence
            const radius = Math.max(2.4, 2.4 + act * 5);
            const geom = new THREE.SphereGeometry(radius, 16, 16);
            const mat = new THREE.MeshLambertMaterial({
              color: baseColor,
              emissive: baseColor,
              emissiveIntensity: 0.2,
              transparent: true,
              opacity: 0.80,
            });
            group.add(new THREE.Mesh(geom, mat));

            const glowGeo = new THREE.SphereGeometry(radius * 1.25, 12, 12);
            const glowMat = new THREE.MeshBasicMaterial({
              color: 0xa78bfa,
              transparent: true,
              opacity: 0.20,
              wireframe: true,
            });
            group.add(new THREE.Mesh(glowGeo, glowMat));
            return group;
          }

          // Default Baseline (no node selected)
          const radius = Math.max(2, 2 + act * 6);
          const geom = new THREE.SphereGeometry(radius, 16, 16);
          const mat = new THREE.MeshLambertMaterial({
            color: baseColor,
            transparent: true,
            opacity: 0.9,
          });
          group.add(new THREE.Mesh(geom, mat));

          if (act > 0.4) {
            const glowGeo = new THREE.SphereGeometry(radius * 1.5, 12, 12);
            const glowMat = new THREE.MeshBasicMaterial({
              color: baseColor,
              transparent: true,
              opacity: act * 0.25,
              wireframe: true,
            });
            group.add(new THREE.Mesh(glowGeo, glowMat));
          }

          return group;
        })
        .linkColor((link: any) => {
          const selNode = selectedNodeRef.current;
          if (!selNode) return "rgba(99, 102, 241, 0.25)";
          const circuit = synapticCircuitRef.current;
          if (circuit.hop1EdgeIds.has(link.id)) return "rgba(56, 189, 248, 0.95)";
          if (circuit.hop2EdgeIds.has(link.id)) return "rgba(167, 139, 250, 0.75)";
          return "rgba(15, 23, 42, 0.04)";
        })
        .linkWidth((link: any) => {
          const selNode = selectedNodeRef.current;
          if (!selNode) return 1.2;
          const circuit = synapticCircuitRef.current;
          if (circuit.hop1EdgeIds.has(link.id)) return 3.2;
          if (circuit.hop2EdgeIds.has(link.id)) return 1.8;
          return 0.2;
        })
        .linkDirectionalParticles((link: any) => {
          const selNode = selectedNodeRef.current;
          if (!selNode) return 2;
          const circuit = synapticCircuitRef.current;
          if (circuit.hop1EdgeIds.has(link.id)) return 6;
          if (circuit.hop2EdgeIds.has(link.id)) return 3;
          return 0;
        })
        .linkDirectionalParticleWidth((link: any) => {
          const selNode = selectedNodeRef.current;
          if (!selNode) return 1.6;
          const circuit = synapticCircuitRef.current;
          if (circuit.hop1EdgeIds.has(link.id)) return 2.6;
          if (circuit.hop2EdgeIds.has(link.id)) return 1.8;
          return 0;
        })
        .linkDirectionalParticleSpeed((link: any) => {
          const selNode = selectedNodeRef.current;
          if (!selNode) return 0.005;
          const circuit = synapticCircuitRef.current;
          if (circuit.hop1EdgeIds.has(link.id)) return 0.016;
          if (circuit.hop2EdgeIds.has(link.id)) return 0.009;
          return 0;
        })
        .linkDirectionalParticleColor((link: any) => {
          const circuit = synapticCircuitRef.current;
          if (circuit.hop1EdgeIds.has(link.id)) return "#38bdf8";
          if (circuit.hop2EdgeIds.has(link.id)) return "#a78bfa";
          return "#38bdf8";
        })
        .onNodeClick((node: GraphNode) => {
          handleNodeClick(node);
        })
        .onBackgroundClick(() => {
          handleDeselect();
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
  }, [filteredData, loading, autoRotate, handleNodeClick, handleDeselect]);

  // Hebbian synaptic clustering & dynamic force adjustment
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    try {
      fg.refresh();
    } catch {
      // non-fatal
    }

    const linkForce = fg.d3Force("link");
    if (!linkForce) return;

    if (selectedNode) {
      linkForce
        .distance((link: any) => {
          const sId = typeof link.source === "object" ? link.source.id : link.source;
          const tId = typeof link.target === "object" ? link.target.id : link.target;
          const isHop1 =
            (sId === selectedNode.id && synapticCircuit.hop1NodeIds.has(tId)) ||
            (tId === selectedNode.id && synapticCircuit.hop1NodeIds.has(sId));
          if (isHop1) return 24; // Tight 1-hop orbit
          const isHop2 =
            synapticCircuit.hop1NodeIds.has(sId) ||
            synapticCircuit.hop1NodeIds.has(tId) ||
            synapticCircuit.hop2NodeIds.has(sId) ||
            synapticCircuit.hop2NodeIds.has(tId);
          if (isHop2) return 42; // Orbiting 2-hop cluster
          return 85; // Lateral inhibition peripheral relaxation
        })
        .strength((link: any) => {
          const sId = typeof link.source === "object" ? link.source.id : link.source;
          const tId = typeof link.target === "object" ? link.target.id : link.target;
          if (sId === selectedNode.id || tId === selectedNode.id) return 1.0;
          if (synapticCircuit.hop1NodeIds.has(sId) || synapticCircuit.hop1NodeIds.has(tId)) return 0.65;
          return 0.15;
        });

      fg.d3ReheatSimulation();
    } else {
      linkForce.distance(55).strength(0.45);
      fg.d3ReheatSimulation();
    }
  }, [selectedNode, synapticCircuit]);

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

      {/* Active Synaptic Circuit Floating Banner */}
      {selectedNode && (
        <div style={{
          position: "absolute",
          top: 76,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(10, 15, 30, 0.92)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(56, 189, 248, 0.4)",
          borderRadius: "16px",
          padding: "8px 18px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          boxShadow: "0 8px 32px rgba(56, 189, 248, 0.22)",
          zIndex: 12,
          pointerEvents: "auto",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#38bdf8",
              boxShadow: "0 0 10px #38bdf8",
            }} />
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#ffffff" }}>
              Synaptic Circuit: <span style={{ color: "#38bdf8" }}>{selectedNode.name}</span>
            </span>
          </div>
          <div style={{ fontSize: "11px", color: "#94a3b8" }}>
            1-hop: <span style={{ color: "#38bdf8", fontWeight: 700 }}>{synapticCircuit.hop1NodeIds.size}</span> · 
            2-hop: <span style={{ color: "#a78bfa", fontWeight: 700 }}>{synapticCircuit.hop2NodeIds.size}</span>
          </div>
          <button
            type="button"
            onClick={handleDeselect}
            title="Release synaptic circuit (Click empty space or Esc)"
            style={{
              background: "rgba(239, 68, 68, 0.15)",
              border: "1px solid rgba(239, 68, 68, 0.35)",
              borderRadius: "8px",
              padding: "4px 9px",
              color: "#fca5a5",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            ✕ Release Focus
          </button>
        </div>
      )}

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
              {syncingNeo4j ? "\u2026" : "\u21BB"}
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

          {/* Synaptic Audio Toggle */}
          <button
            type="button"
            onClick={toggleAudio}
            title={audioEnabled ? "Synaptic Audio: Active (Click to mute)" : "Synaptic Audio: Muted (Click to unmute)"}
            style={{
              background: audioEnabled ? "rgba(56, 189, 248, 0.2)" : "rgba(13, 17, 30, 0.85)",
              backdropFilter: "blur(16px)",
              border: `1px solid ${audioEnabled ? "rgba(56, 189, 248, 0.5)" : "rgba(255, 255, 255, 0.1)"}`,
              borderRadius: "12px",
              padding: "8px 12px",
              color: audioEnabled ? "#38bdf8" : "#64748b",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{audioEnabled ? "🔊" : "🔇"}</span>
            <span style={{ fontSize: "11px" }}>{audioEnabled ? "Sound ON" : "Muted"}</span>
          </button>

          {/* Reset Camera */}
          <button
            type="button"
            onClick={() => {
              fgRef.current?.cameraPosition({ x: 0, y: 0, z: 220 }, { x: 0, y: 0, z: 0 }, 1000);
              handleDeselect();
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

          {/* Brain Analytics & Query Button */}
          <button
            type="button"
            onClick={() => {
              const next = !showAnalytics;
              setShowAnalytics(next);
              if (next && !analytics) void loadAnalytics();
            }}
            style={{
              background: showAnalytics ? "rgba(56, 189, 248, 0.25)" : "rgba(13, 17, 30, 0.85)",
              backdropFilter: "blur(16px)",
              border: `1px solid ${showAnalytics ? "rgba(56, 189, 248, 0.5)" : "rgba(255, 255, 255, 0.1)"}`,
              borderRadius: "12px",
              padding: "8px 12px",
              color: showAnalytics ? "#38bdf8" : "#94a3b8",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {showAnalytics ? "Close Insights" : "Brain Analytics"}
          </button>
        </div>
      </div>

      {/* Brain Analytics & Natural Language Query Drawer */}
      {showAnalytics && (
        <div style={{
          position: "absolute",
          top: 80,
          left: 20,
          width: "360px",
          maxHeight: "calc(100% - 130px)",
          overflowY: "auto",
          background: "rgba(13, 17, 30, 0.94)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(56, 189, 248, 0.3)",
          borderRadius: "18px",
          padding: "18px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.8)",
          zIndex: 25,
          color: "#f8fafc",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#38bdf8" }}>
              Living Brain Analytics & Query
            </div>
            <button
              type="button"
              onClick={() => setShowAnalytics(false)}
              style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: "16px" }}
            >
              {"\u2715"}
            </button>
          </div>

          {analyticsError && (
            <div style={{ background: "rgba(244,63,94,0.15)", border: "1px solid rgba(244,63,94,0.3)", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: "#f87171", marginBottom: 12 }}>
              {analyticsError}
            </div>
          )}

          {/* NL / Cypher Query Form */}
          <form onSubmit={handleRunNlQuery} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                placeholder={nlQueryMode === "nl" ? "Ask brain (e.g. 'hermes', 'stale')..." : "MATCH (n:Entity) RETURN n LIMIT 10"}
                value={nlQueryInput}
                onChange={(e) => setNlQueryInput(e.target.value)}
                style={{
                  flex: 1,
                  background: "rgba(255, 255, 255, 0.05)",
                  border: "1px solid rgba(255, 255, 255, 0.12)",
                  borderRadius: "10px",
                  padding: "6px 10px",
                  color: "#ffffff",
                  fontSize: "12px",
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={nlQueryRunning}
                style={{
                  background: "#38bdf8",
                  color: "#0f172a",
                  border: "none",
                  borderRadius: "10px",
                  padding: "6px 12px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {nlQueryRunning ? "\u2026" : "Run"}
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setNlQueryMode("nl")}
                  style={{
                    background: nlQueryMode === "nl" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                    border: `1px solid ${nlQueryMode === "nl" ? "#38bdf8" : "rgba(255,255,255,0.1)"}`,
                    color: nlQueryMode === "nl" ? "#38bdf8" : "#94a3b8",
                    padding: "2px 8px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "10px",
                  }}
                >
                  Natural Language
                </button>
                <button
                  type="button"
                  onClick={() => setNlQueryMode("cypher")}
                  style={{
                    background: nlQueryMode === "cypher" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                    border: `1px solid ${nlQueryMode === "cypher" ? "#38bdf8" : "rgba(255,255,255,0.1)"}`,
                    color: nlQueryMode === "cypher" ? "#38bdf8" : "#94a3b8",
                    padding: "2px 8px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "10px",
                  }}
                >
                  Cypher
                </button>
              </div>
              <button
                type="button"
                onClick={() => void loadAnalytics()}
                disabled={analyticsLoading}
                style={{ background: "transparent", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: "11px" }}
              >
                {analyticsLoading ? "Refreshing\u2026" : "\u21BB Refresh"}
              </button>
            </div>
          </form>

          {nlQueryError && (
            <div style={{ background: "rgba(244,63,94,0.15)", border: "1px solid rgba(244,63,94,0.3)", borderRadius: "8px", padding: "8px", fontSize: "11px", color: "#f87171", marginBottom: 12 }}>
              {nlQueryError}
            </div>
          )}

          {/* Query Results */}
          {nlQueryResult && (
            <div style={{ marginBottom: 16, background: "rgba(0,0,0,0.3)", borderRadius: "10px", padding: "10px", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#34d399", marginBottom: 6 }}>
                Matches: {nlQueryResult.rows.length} rows ({nlQueryResult.matchedEntityIds.length} neurons focused)
              </div>
              <div style={{ maxHeight: "140px", overflowY: "auto", fontSize: "11px" }}>
                {nlQueryResult.rows.map((row, idx) => (
                  <div
                    key={idx}
                    onClick={() => {
                      if (typeof row.id === "string" && graphData) {
                        const m = graphData.entities.find((e) => e.id === row.id);
                        if (m) handleNodeClick(m as GraphNode);
                      }
                    }}
                    style={{
                      padding: "4px 6px",
                      borderRadius: "6px",
                      background: idx % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      color: "#e2e8f0",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{String(row.label ?? row.id ?? "")}</span>
                    <span style={{ color: "#94a3b8", fontSize: "10px" }}>{String(row.type ?? "")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Centrality Hubs */}
          {analytics && (
            <div>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#cbd5e1", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                <span>Top Central Synapses (Hubs)</span>
                <span style={{ color: "#64748b", fontSize: "11px" }}>Degree</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
                {analytics.hubs.slice(0, 5).map((hub) => (
                  <div
                    key={hub.id}
                    onClick={() => {
                      if (graphData) {
                        const m = graphData.entities.find((e) => e.id === hub.id);
                        if (m) handleNodeClick(m as GraphNode);
                      }
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 8px",
                      borderRadius: "8px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.05)",
                      cursor: "pointer",
                      fontSize: "11px",
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 600, color: "#ffffff" }}>{hub.label}</span>
                      <span style={{ marginLeft: 6, fontSize: "9px", color: getNodeColor(hub.type) }}>{hub.type}</span>
                    </div>
                    <span style={{ fontWeight: 700, color: "#38bdf8" }}>{hub.degree}</span>
                  </div>
                ))}
              </div>

              {/* Neglected / Stale Entities */}
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#cbd5e1", marginBottom: 8 }}>
                Stale / Neglected Knowledge
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {analytics.staleEntities.slice(0, 4).map((stale) => (
                  <div
                    key={stale.id}
                    onClick={() => {
                      if (graphData) {
                        const m = graphData.entities.find((e) => e.id === stale.id);
                        if (m) handleNodeClick(m as GraphNode);
                      }
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 8px",
                      borderRadius: "8px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.05)",
                      cursor: "pointer",
                      fontSize: "11px",
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 600, color: "#ffffff" }}>{stale.label}</span>
                      <span style={{ marginLeft: 6, fontSize: "9px", color: getNodeColor(stale.type) }}>{stale.type}</span>
                    </div>
                    <span style={{ color: "#f43f5e", fontSize: "10px" }}>
                      {stale.lastActive ? new Date(stale.lastActive).toLocaleDateString() : "idle"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
        <button
          type="button"
          onClick={() => setHideFloatingOrphans((prev) => !prev)}
          title="Toggle visibility of unlinked floating documents"
          style={{
            background: hideFloatingOrphans ? "rgba(56, 189, 248, 0.25)" : "rgba(13, 17, 30, 0.75)",
            backdropFilter: "blur(12px)",
            border: `1px solid ${hideFloatingOrphans ? "#38bdf8" : "rgba(255, 255, 255, 0.08)"}`,
            color: hideFloatingOrphans ? "#38bdf8" : "#94a3b8",
            fontSize: "11px",
            fontWeight: 700,
            padding: "5px 12px",
            borderRadius: "20px",
            cursor: "pointer",
            transition: "all 180ms ease",
          }}
        >
          {hideFloatingOrphans ? "⚡ Connected Only" : "🌐 All Nodes"}
        </button>
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
              {"\u2715"}
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
                {copiedQuery ? "\u2713 Copied to Clipboard" : "Copy Cypher Query"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
