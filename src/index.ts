#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fastify from "fastify";
import { z } from "zod";
import Redis from "ioredis";

interface Memory {
  id: string;
  content: string;
  userId: string;
  timestamp: Date;
}

class QuinnMemoryServer {
  private server: McpServer;
  private memories: Memory[] = [];
  private fastifyServer: any;
  private redis: Redis;

  constructor() {
    this.server = new McpServer({
      name: "quinn-memory-mcp-server",
      version: "1.0.0",
    });

    // Initialize Redis/DragonflyDB connection
    this.redis = new Redis({
      host: process.env.DRAGONFLY_HOST || 'dragonflydb.railway.internal',
      port: parseInt(process.env.DRAGONFLY_PORT || '6379'),
      // Fallback to in-memory if Redis unavailable
      lazyConnect: true,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 1,
    });

    this.setupToolHandlers();
    this.setupFastifyServer();
  }

  private setupToolHandlers() {
    // Register add-memory tool
    this.server.registerTool(
      "add-memory",
      {
        title: "Add Memory",
        description: "Add a new memory. This method is called everytime the user informs anything about themselves, their preferences, or anything that has any relevent information whcih can be useful in the future conversation. This can also be called when the user asks you to remember something.",
        inputSchema: {
          content: z.string(),
          userId: z.string().default("quinn_may"),
        }
      },
      async ({ content, userId }) => {
        return await this.addMemory({ content, userId });
      }
    );

    // Register search-memories tool  
    this.server.registerTool(
      "search-memories",
      {
        title: "Search Memories",
        description: "Search through stored memories. This method is called ANYTIME the user asks anything.",
        inputSchema: {
          query: z.string(),
          userId: z.string().default("quinn_may"),
        }
      },
      async ({ query, userId }) => {
        return await this.searchMemories({ query, userId });
      }
    );
  }

  private async addMemory(args: any) {
    const schema = z.object({
      content: z.string(),
      userId: z.string().default("quinn_may"),
    });

    const { content, userId } = schema.parse(args);
    
    const memory: Memory = {
      id: Math.random().toString(36).substring(2, 15),
      content,
      userId,
      timestamp: new Date(),
    };

    try {
      // Store in DragonflyDB
      const memoryKey = `memory:${userId}:${memory.id}`;
      const memoryData = JSON.stringify({
        id: memory.id,
        content: memory.content,
        userId: memory.userId,
        timestamp: memory.timestamp.toISOString(),
      });
      
      await this.redis.set(memoryKey, memoryData);
      
      // Add to user's memory list for search
      await this.redis.zadd(`memories:${userId}`, Date.now(), memory.id);
      
      console.log(`Memory stored in DragonflyDB: ${memoryKey}`);
    } catch (error) {
      console.error('DragonflyDB error, using fallback:', error);
      // Fallback to in-memory storage
      this.memories.push(memory);
    }

    return {
      content: [
        {
          type: "text",
          text: `Memory added successfully for user ${userId}. Memory ID: ${memory.id}`,
        },
      ],
    };
  }

  private async searchMemories(args: any) {
    const schema = z.object({
      query: z.string(),
      userId: z.string().default("quinn_may"),
    });

    const { query, userId } = schema.parse(args);

    let results: any[] = [];

    try {
      // Search in DragonflyDB
      const memoryIds = await this.redis.zrevrange(`memories:${userId}`, 0, 99); // Get last 100 memories
      const memories = [];
      
      for (const memoryId of memoryIds) {
        const memoryKey = `memory:${userId}:${memoryId}`;
        const memoryData = await this.redis.get(memoryKey);
        if (memoryData) {
          const memory = JSON.parse(memoryData);
          if (memory.content.toLowerCase().includes(query.toLowerCase())) {
            memories.push({
              id: memory.id,
              content: memory.content,
              timestamp: memory.timestamp,
            });
          }
        }
      }
      
      results = memories
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 10);
        
      console.log(`Found ${results.length} memories in DragonflyDB for query: ${query}`);
    } catch (error) {
      console.error('DragonflyDB error, using fallback:', error);
      // Fallback to in-memory search
      const userMemories = this.memories.filter(m => m.userId === userId);
      const relevantMemories = userMemories.filter(memory =>
        memory.content.toLowerCase().includes(query.toLowerCase())
      );

      results = relevantMemories
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 10)
        .map(memory => ({
          id: memory.id,
          content: memory.content,
          timestamp: memory.timestamp.toISOString(),
        }));
    }

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} memories for query "${query}":

${results
            .map((r, i) => `${i + 1}. [${r.timestamp}] ${r.content}`)
            .join("\n")}`,
        },
      ],
    };
  }

  private async setupFastifyServer() {
    this.fastifyServer = fastify({
      logger: true,
    });

    // CORS configuration for MCP
    await this.fastifyServer.register(require('@fastify/cors'), {
      origin: true,
      credentials: true,
      exposedHeaders: ['Mcp-Session-Id'],
    });

    // Bearer token authentication middleware
    this.fastifyServer.addHook('preHandler', async (request: any, reply: any) => {
      if (request.url === '/health') {
        return; // Skip auth for health check
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Bearer token required' });
        return;
      }

      const token = authHeader.substring(7);
      const validToken = process.env.MCP_BEARER_TOKEN || 'default-token-change-me';
      
      if (token !== validToken) {
        reply.code(401).send({ error: 'Invalid bearer token' });
        return;
      }
    });

    // Health check endpoint
    this.fastifyServer.get('/health', async () => {
      let dragonflyStatus = 'unavailable';
      try {
        await this.redis.ping();
        dragonflyStatus = 'connected';
      } catch (error) {
        console.error('DragonflyDB health check failed:', error);
      }
      
      return { 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        dragonfly: dragonflyStatus,
        fallback: dragonflyStatus === 'unavailable' ? 'in-memory' : 'not needed'
      };
    });

    // MCP HTTP transport endpoint
    this.fastifyServer.post('/mcp', async (request: any, reply: any) => {
      try {
        // Create stateless transport for each request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode
        });

        // Set up connection cleanup
        reply.raw.on('close', () => {
          transport.close();
        });

        // Connect the server to transport and handle the request
        await this.server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        console.error('MCP request error:', error);
        if (!reply.sent) {
          reply.code(500).send({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal error",
              data: error instanceof Error ? error.message : String(error),
            },
            id: request.body?.id || null,
          });
        }
      }
    });

    // Start server
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    
    try {
      await this.fastifyServer.listen({ port, host });
      console.log(`Quinn Memory MCP Server running on ${host}:${port}`);
      console.log(`Health check: http://${host}:${port}/health`);
      console.log(`MCP endpoint: http://${host}:${port}/mcp`);
      console.log('Bearer token auth required for MCP endpoint');
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  }

  async start() {
    // Server is started in setupFastifyServer
  }
}

// Start the server
const memoryServer = new QuinnMemoryServer();
memoryServer.start().catch(console.error);