import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const PORT = Number(process.env.PORT || 3000);
const SERVICE_NAME = "master-brain-mcp";
const SERVICE_VERSION = "0.1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const architecture = {
  name: "Master Brain",
  principle: "From contradiction to proof",
  layers: [
    "Central Core",
    "Strategic Intelligence / Cognition",
    "Domain islands: general, industrial, economics and markets, accounting, future",
    "AI models",
    "Agents and tools"
  ],
  controls: [
    "Evidence before conclusions",
    "Explicitly label unknown or unverified claims",
    "Track contradictions rather than silently discarding them",
    "Record provenance and verification status",
    "Prefer reversible, low-cost actions"
  ],
  status: "starter_blueprint_only"
};

function createMcpServer() {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });

  server.registerTool("master_brain_status", {
    title: "Master Brain status",
    description: "Returns this cloud MCP starter's status and safety boundaries. Does not inspect or control the user's computer.",
    inputSchema: {}
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify({
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      status: "healthy",
      mode: "read_only",
      storage: "none",
      local_computer_access: false,
      external_actions: false,
      project_implementation: "starter_blueprint_only",
      timestamp: new Date().toISOString()
    }, null, 2) }]
  }));

  server.registerTool("master_brain_architecture", {
    title: "Master Brain architecture",
    description: "Returns the starter blueprint and design principles. This does not claim the full system has been implemented.",
    inputSchema: {}
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(architecture, null, 2) }]
  }));

  server.registerTool("proof_audit_template", {
    title: "Prepare a proof audit",
    description: "Structures a claim for evidence review. It does not independently verify facts or browse the web; sources must be supplied by the caller.",
    inputSchema: {
      claim: z.string().min(1).max(2000).describe("The claim to review"),
      context: z.string().max(2000).optional().describe("Optional context or decision affected"),
      sources: z.array(z.object({
        title: z.string().min(1).max(300),
        url: z.string().url().optional(),
        excerpt: z.string().max(3000).optional(),
        source_date: z.string().max(100).optional()
      })).max(20).optional().describe("Evidence supplied for review")
    }
  }, async ({ claim, context, sources = [] }) => {
    const audit = {
      claim,
      context: context ?? null,
      status: sources.length ? "evidence_supplied_not_independently_verified" : "unverified_no_sources",
      evidence_count: sources.length,
      evidence: sources.map((source, index) => ({
        id: "E" + (index + 1),
        ...source,
        independently_verified: false
      })),
      contradictions: [],
      missing_checks: [
        "Verify source identity and authority",
        "Check publication date and whether evidence is current",
        "Compare each excerpt with the full source context",
        "Search for credible counter-evidence",
        "Separate direct evidence from inference"
      ],
      conclusion: "No factual conclusion has been established by this tool."
    };
    return { content: [{ type: "text", text: JSON.stringify(audit, null, 2) }] };
  });

  return server;
}

app.get("/healthz", (_req, res) => res.status(200).json({
  status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION, mode: "read_only"
}));

app.get("/", (_req, res) => res.redirect(302, "/app"));

app.get("/app", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on("close", () => { transport.close().catch(() => {}); });
  try {
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal MCP server error" },
      id: req.body?.id ?? null
    });
    console.error("MCP request failed:", error instanceof Error ? error.message : "unknown error");
  }
});

app.all("/mcp", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ error: "This stateless starter accepts MCP POST requests only." });
});

app.listen(PORT, "0.0.0.0", () => console.log(SERVICE_NAME + " listening on port " + PORT));
