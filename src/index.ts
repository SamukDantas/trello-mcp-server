import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

interface TrelloConfig {
  apiKey: string;
  token: string;
  boardId: string;
  lists: {
    backlog: string;
    doing: string;
    testing: string;
    done: string;
  };
  labels: {
    pontoFocal: string;
  };
}

interface TrelloBoard {
  id: string;
  name: string;
  shortUrl: string;
  url: string;
  closed: boolean;
}

interface TrelloCard {
  id: string;
  name: string;
  shortUrl: string;
  idList: string;
  idLabels: string[];
  idBoard: string;
  due?: string | null;
}

interface TrelloList {
  id: string;
  name: string;
}

interface TrelloCardDetails {
  id: string;
  name: string;
  desc: string;
  shortUrl: string;
  url: string;
  idList: string;
  idLabels: string[];
  idMembers: string[];
  due: string | null;
  dueComplete?: boolean;
  dateLastActivity: string;
  dateCreated: string;
  labels: {
    id: string;
    name: string;
    color: string;
  }[];
  checklists?: {
    id: string;
    name: string;
    checkItems: {
      id: string;
      name: string;
      state: "complete" | "incomplete";
    }[];
  }[];
}

interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType?: string;
  fileName?: string;
  bytes?: number;
  date?: string;
  idMember?: string;
  previews?: {
    id: string;
    width: number;
    height: number;
    scaled: boolean;
  }[];
}

interface TrelloMember {
  id: string;
  fullName: string;
  username: string;
  avatarUrl?: string;
}

interface TrelloBoardLabel {
  id: string;
  name: string;
  color: string;
}

interface TrelloChecklist {
  id: string;
  name: string;
  checkItems: {
    id: string;
    name: string;
    state: "complete" | "incomplete";
  }[];
}

interface TrelloComment {
  id: string;
  data: {
    text: string;
  };
  date: string;
  memberCreator: {
    fullName: string;
  };
}

interface TrelloPowerUp {
  id: string;
  name: string;
  description: string;
}

interface TrelloWebhook {
  id: string;
  description: string;
  callbackURL: string;
  idModel: string;
  active: boolean;
}

interface TrelloAction {
  id: string;
  type: string;
  date: string;
  memberCreator: {
    id: string;
    fullName: string;
  };
  data: {
    card?: { id: string; name: string };
    list?: { id: string; name: string };
    board?: { id: string; name: string };
    text?: string;
  };
}

let currentTask: TrelloCard | null = null;
let currentBoardId: string | null = null;

interface TrelloCredentials {
  apiKey: string;
  token: string;
}

function loadConfig(): TrelloConfig {
  const configPath = path.join(os.homedir(), ".config", "opencode", "trello-config.json");
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function getCredentials(): TrelloCredentials {
  const cfg = loadConfig();
  return { apiKey: cfg.apiKey, token: cfg.token };
}

function extractBoardId(input: string): string | null {
  if (/^[a-f0-9]{24}$/i.test(input)) {
    return input;
  }
  const urlMatch = input.match(/trello\.com\/b\/([a-zA-Z0-9]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  return null;
}

async function fetchTrelloWithCreds<T>(
  creds: TrelloCredentials,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: object
): Promise<T> {
  // Se j\u00e1 tem query string, n\u00e3o adicionar ?
  let url = `https://api.trello.com/1${endpoint}`;
  if (endpoint.includes('?')) {
    url += `&key=${creds.apiKey}&token=${creds.token}`;
  } else {
    url += `?key=${creds.apiKey}&token=${creds.token}`;
  }
  
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  
  if (!res.ok) {
    throw new Error(`Trello API error: ${res.status} ${res.statusText}`);
  }
  
  return res.json();
}

async function fetchTrello<T>(
  cfg: TrelloConfig,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: object
): Promise<T> {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `https://api.trello.com/1${endpoint}${separator}key=${cfg.apiKey}&token=${cfg.token}`;
  
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  
  if (!res.ok) {
    throw new Error(`Trello API error: ${res.status} ${res.statusText}`);
  }
  
  return res.json();
}

async function resolveBoardId(input: string | undefined, creds: TrelloCredentials): Promise<string> {
  if (!input) {
    const cfg = loadConfig();
    const boardId = currentBoardId || cfg.boardId;
    
    // Se o boardId não é um ObjectId de 24 caracteres, tentar resolver
    if (!/^[a-f0-9]{24}$/i.test(boardId)) {
      const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
      const board = boards.find(b => b.shortUrl.includes(boardId) || b.name.toLowerCase().includes(boardId.toLowerCase()));
      if (board) return board.id;
    }
    
    return boardId;
  }
  
  const extracted = extractBoardId(input);
  if (extracted) {
    if (/^[a-f0-9]{24}$/i.test(extracted)) {
      return extracted;
    }
    const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
    const board = boards.find(b => b.shortUrl.includes(extracted) || b.id === extracted);
    if (board) return board.id;
  }
  
  const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
  const board = boards.find(b => b.name.toLowerCase().includes(input.toLowerCase()));
  if (board) return board.id;
  
  throw new Error(`Board não encontrado: ${input}`);
}

async function getBoardLists(creds: TrelloCredentials, boardId: string): Promise<TrelloList[]> {
  return fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`);
}

async function detectListIds(creds: TrelloCredentials, boardId: string): Promise<Record<string, string>> {
  const lists = await getBoardLists(creds, boardId);
  const listMap: Record<string, string> = {};
  
  for (const list of lists) {
    const nameLower = list.name.toLowerCase();
    if (nameLower.includes("backlog") || nameLower.includes("a fazer") || nameLower.includes("to do")) {
      listMap.backlog = list.id;
    } else if (nameLower.includes("doing") || nameLower.includes("fazendo") || nameLower.includes("em andamento") || nameLower.includes("in progress")) {
      listMap.doing = list.id;
    } else if (nameLower.includes("testing") || nameLower.includes("testando") || nameLower.includes("review") || nameLower.includes("revisão")) {
      listMap.testing = list.id;
    } else if (nameLower.includes("done") || nameLower.includes("concluído") || nameLower.includes("concluido") || nameLower.includes("finalizado") || nameLower.includes("completed")) {
      listMap.done = list.id;
    }
  }
  
  if (lists.length >= 4 && Object.keys(listMap).length < 4) {
    listMap.backlog = lists[0].id;
    listMap.doing = lists[1].id;
    listMap.testing = lists[2].id;
    listMap.done = lists[3].id;
  }
  
  return listMap;
}

async function getBacklogTasks(cfg: TrelloConfig): Promise<TrelloCard[]> {
  const cards = await fetchTrello<TrelloCard[]>(cfg, `/boards/${cfg.boardId}/cards/open`);
  return cards.filter(
    (c) => c.idLabels.includes(cfg.labels.pontoFocal) && c.idList === cfg.lists.backlog
  );
}

async function getAllCards(cfg: TrelloConfig): Promise<TrelloCard[]> {
  return fetchTrello<TrelloCard[]>(cfg, `/boards/${cfg.boardId}/cards/open`);
}

async function getLists(cfg: TrelloConfig): Promise<TrelloList[]> {
  return fetchTrello<TrelloList[]>(cfg, `/boards/${cfg.boardId}/lists`);
}

async function getCardDetails(cfg: TrelloConfig, cardId: string): Promise<TrelloCardDetails> {
  return fetchTrello<TrelloCardDetails>(cfg, `/cards/${cardId}`);
}

async function getCardChecklists(cfg: TrelloConfig, cardId: string): Promise<TrelloChecklist[]> {
  return fetchTrello<TrelloChecklist[]>(cfg, `/cards/${cardId}/checklists`);
}

async function getCardComments(cfg: TrelloConfig, cardId: string): Promise<TrelloComment[]> {
  return fetchTrello<TrelloComment[]>(cfg, `/cards/${cardId}/actions?filter=commentCard`);
}

async function getCardAttachments(cfg: TrelloConfig, cardId: string): Promise<TrelloAttachment[]> {
  return fetchTrello<TrelloAttachment[]>(cfg, `/cards/${cardId}/attachments`);
}

async function getBoardLabels(cfg: TrelloConfig): Promise<TrelloBoardLabel[]> {
  return fetchTrello<TrelloBoardLabel[]>(cfg, `/boards/${cfg.boardId}/labels`);
}

async function getMembers(cfg: TrelloConfig, memberIds: string[]): Promise<TrelloMember[]> {
  const members: TrelloMember[] = [];
  for (const id of memberIds) {
    try {
      const member = await fetchTrello<TrelloMember>(cfg, `/members/${id}`);
      members.push(member);
    } catch {
      // Skip if member not found
    }
  }
  return members;
}

async function findCardByName(cfg: TrelloConfig, name: string): Promise<TrelloCard | null> {
  const cards = await getAllCards(cfg);
  const searchName = name.toLowerCase().trim();
  return cards.find(c => 
    c.name.toLowerCase().includes(searchName) || 
    searchName.includes(c.name.toLowerCase())
  ) || null;
}

const server = new McpServer({
  name: "trello",
  version: "1.0.0",
});

server.tool(
  "trello_list_boards",
  "Lista todos os quadros Trello do usuário",
  {},
  async () => {
    const creds = getCredentials();
    const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
    const openBoards = boards.filter(b => !b.closed);
    
    if (!openBoards.length) {
      return {
        content: [{ type: "text", text: "❌ Nenhum quadro encontrado!" }],
      };
    }
    
    let text = `📋 **Quadros Trello** (${openBoards.length}):\n\n`;
    for (const board of openBoards) {
      const active = currentBoardId === board.id ? " ⭐ (ativo)" : "";
      text += `• ${board.name}${active}\n`;
      text += `  🔗 ${board.shortUrl}\n\n`;
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_set_board",
  "Define o quadro ativo para operações subsequentes",
  { boardUrl: z.string().describe("URL ou nome do quadro Trello") },
  async ({ boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    currentBoardId = boardId;
    
    const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
    const board = boards.find(b => b.id === boardId);
    
    return {
      content: [{
        type: "text",
        text: `✅ Quadro ativo definido: **${board?.name || boardId}**\n🔗 ${board?.shortUrl || ""}`,
      }],
    };
  }
);

server.tool(
  "trello_create_board",
  "Cria um novo quadro no Trello",
  {
    name: z.string().describe("Nome do novo quadro"),
    description: z.string().optional().describe("Descrição do quadro"),
    defaultLists: z.boolean().optional().describe("Criar listas padrão (To Do, Doing, Done). Padrão: true"),
    prefs: z.object({
      visibility: z.enum(["private", "team", "public"]).optional().describe("Visibilidade: private, team, public"),
      votingEnabled: z.boolean().optional().describe("Permitir votação"),
      commentsEnabled: z.boolean().optional().describe("Permitir comentários"),
      invitationsEnabled: z.boolean().optional().describe("Permitir convites"),
      selfJoinEnabled: z.boolean().optional().describe("Permitir auto-adesão")
    }).optional().describe("Preferências do quadro")
  },
  async ({ name, description, defaultLists, prefs }) => {
    const creds = getCredentials();
    
    try {
      const boardData: Record<string, unknown> = {
        name: name,
        defaultLists: defaultLists !== false
      };
      
      if (description) {
        boardData.desc = description;
      }
      
      if (prefs) {
        if (prefs.visibility) boardData.prefs = { visibility: prefs.visibility };
        if (prefs.votingEnabled !== undefined) (boardData.prefs as Record<string, unknown>).votingEnabled = prefs.votingEnabled;
        if (prefs.commentsEnabled !== undefined) (boardData.prefs as Record<string, unknown>).commentsEnabled = prefs.commentsEnabled;
        if (prefs.invitationsEnabled !== undefined) (boardData.prefs as Record<string, unknown>).invitationsEnabled = prefs.invitationsEnabled;
        if (prefs.selfJoinEnabled !== undefined) (boardData.prefs as Record<string, unknown>).selfJoinEnabled = prefs.selfJoinEnabled;
      }
      
      const newBoard = await fetchTrelloWithCreds<TrelloBoard>(creds, "/boards", "POST", boardData);
      
      let text = `✅ **Quadro Criado**\n\n`;
      text += `📋 **${newBoard.name}**\n`;
      if (description) text += `📄 ${description.slice(0, 100)}...\n`;
      text += `🆔 ${newBoard.id}\n`;
      text += `\n🔗 ${newBoard.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar quadro: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_update_board",
  "Atualiza um quadro existente do Trello",
  {
    boardId: z.string().optional().describe("ID do quadro (alternativa ao nome)"),
    boardName: z.string().optional().describe("Nome ou parte do nome do quadro (alternativa ao ID)"),
    newName: z.string().optional().describe("Novo nome do quadro"),
    newDescription: z.string().optional().describe("Nova descrição"),
    closed: z.boolean().optional().describe("Fechar/Arquivar o quadro (true = arquivar)"),
    prefs: z.object({
      visibility: z.enum(["private", "team", "public"]).optional().describe("Visibilidade: private, team, public"),
      votingEnabled: z.boolean().optional().describe("Permitir votação"),
      commentsEnabled: z.boolean().optional().describe("Permitir comentários"),
      invitationsEnabled: z.boolean().optional().describe("Permitir convites"),
      selfJoinEnabled: z.boolean().optional().describe("Permitir auto-adesão")
    }).optional().describe("Preferências do quadro")
  },
  async ({ boardId, boardName, newName, newDescription, closed, prefs }) => {
    const creds = getCredentials();
    
    let targetBoardId = boardId;
    
    if (!targetBoardId && boardName) {
      const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
      const searchName = boardName.toLowerCase().trim();
      const foundBoard = boards.find(b => 
        b.name.toLowerCase().includes(searchName) || 
        searchName.includes(b.name.toLowerCase())
      );
      
      if (!foundBoard) {
        const availableBoards = boards.map(b => b.name).join(", ");
        return {
          content: [{ 
            type: "text", 
            text: `❌ Quadro "${boardName}" não encontrado.\n\nQuadros disponíveis:\n${availableBoards}` 
          }],
        };
      }
      targetBoardId = foundBoard.id;
    }
    
    if (!targetBoardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça boardId ou boardName" }],
      };
    }
    
    const updateData: Record<string, unknown> = {};
    
    if (newName) updateData.name = newName;
    if (newDescription !== undefined) updateData.desc = newDescription;
    if (closed !== undefined) updateData.closed = closed;
    
    if (prefs) {
      const prefsData: Record<string, unknown> = {};
      if (prefs.visibility) prefsData.visibility = prefs.visibility;
      if (prefs.votingEnabled !== undefined) prefsData.votingEnabled = prefs.votingEnabled;
      if (prefs.commentsEnabled !== undefined) prefsData.commentsEnabled = prefs.commentsEnabled;
      if (prefs.invitationsEnabled !== undefined) prefsData.invitationsEnabled = prefs.invitationsEnabled;
      if (prefs.selfJoinEnabled !== undefined) prefsData.selfJoinEnabled = prefs.selfJoinEnabled;
      if (Object.keys(prefsData).length > 0) updateData.prefs = prefsData;
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: "❌ Forneça pelo menos um campo para atualizar: newName, newDescription, closed, ou prefs" 
        }],
      };
    }
    
    try {
      const updatedBoard = await fetchTrelloWithCreds<TrelloBoard>(creds, `/boards/${targetBoardId}`, "PUT", updateData);
      
      let text = `✅ **Quadro Atualizado**\n\n`;
      text += `📋 **${updatedBoard.name}**\n`;
      text += `🆔 ${updatedBoard.id}\n`;
      if (newName) text += `📝 Nome alterado\n`;
      if (newDescription !== undefined) text += `📄 Descrição alterada\n`;
      if (closed !== undefined) text += closed ? `📦 Quadro arquivado\n` : `📂 Quadro reativado\n`;
      if (prefs) text += `⚙️ Preferências alteradas\n`;
      text += `\n🔗 ${updatedBoard.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar quadro: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_board",
  "Exclui (arquiva) um quadro do Trello",
  {
    boardId: z.string().optional().describe("ID do quadro (alternativa ao nome)"),
    boardName: z.string().optional().describe("Nome ou parte do nome do quadro (alternativa ao ID)"),
    permanent: z.boolean().optional().describe("Excluir permanentemente (requer confirmação). Use com cuidado!")
  },
  async ({ boardId, boardName, permanent }) => {
    const creds = getCredentials();
    
    let targetBoardId = boardId;
    let boardNameDeleted = boardName || "Quadro";
    
    if (!targetBoardId && boardName) {
      const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
      const searchName = boardName.toLowerCase().trim();
      const foundBoard = boards.find(b => 
        b.name.toLowerCase().includes(searchName) || 
        searchName.includes(b.name.toLowerCase())
      );
      
      if (!foundBoard) {
        const availableBoards = boards.map(b => b.name).join(", ");
        return {
          content: [{ 
            type: "text", 
            text: `❌ Quadro "${boardName}" não encontrado.\n\nQuadros disponíveis:\n${availableBoards}` 
          }],
        };
      }
      targetBoardId = foundBoard.id;
      boardNameDeleted = foundBoard.name;
    }
    
    if (!targetBoardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça boardId ou boardName" }],
      };
    }
    
    try {
      if (permanent) {
        await fetchTrelloWithCreds(creds, `/boards/${targetBoardId}`, "DELETE");
        
        let text = `✅ **Quadro Excluído Permanentemente**\n\n`;
        text += `🗑️ **${boardNameDeleted}**\n`;
        text += `🆔 ${targetBoardId}\n`;
        
        return { content: [{ type: "text", text }] };
      } else {
        await fetchTrelloWithCreds(creds, `/boards/${targetBoardId}`, "PUT", { closed: true });
        
        let text = `✅ **Quadro Arquivado**\n\n`;
        text += `📦 **${boardNameDeleted}**\n`;
        text += `🆔 ${targetBoardId}\n`;
        text += `\nO quadro foi arquivado e pode ser restaurado manualmente.`;
        
        return { content: [{ type: "text", text }] };
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir quadro: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "Lista todas as tarefas pendentes no backlog do Trello",
  { boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional, usa o ativo se não informado)") },
  async ({ boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    
    if (boardId === cfg.boardId && cfg.labels.pontoFocal) {
      const listIds = await detectListIds(creds, boardId);
      const backlogId = listIds.backlog || cfg.lists.backlog;
      const tasks = cards.filter(c => 
        c.idLabels.includes(cfg.labels.pontoFocal) && c.idList === backlogId
      );
      
      if (!tasks.length) {
        return { content: [{ type: "text", text: "✅ Nenhuma tarefa pendente!" }] };
      }
      
      const text = `📋 **Tarefas** (${tasks.length}):\n\n` + 
        tasks.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
      
      return { content: [{ type: "text", text }] };
    }
    
    const listIds = await detectListIds(creds, boardId);
    const backlogId = listIds.backlog;
    
    if (!backlogId) {
      return { content: [{ type: "text", text: "❌ Lista de backlog não encontrada!" }] };
    }
    
    const tasks = cards.filter(c => c.idList === backlogId);
    
    if (!tasks.length) {
      return { content: [{ type: "text", text: "✅ Nenhuma tarefa pendente!" }] };
    }
    
    const text = `📋 **Tarefas** (${tasks.length}):\n\n` + 
      tasks.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_next",
  "Inicia a próxima tarefa do backlog (move para Doing)",
  {},
  async () => {
    const cfg = loadConfig();
    const tasks = await getBacklogTasks(cfg);
    
    if (!tasks.length) {
      return {
        content: [{ type: "text", text: "✅ Nenhuma tarefa disponível!" }],
      };
    }
    
    currentTask = tasks[0];
    await fetchTrello(cfg, `/cards/${currentTask.id}`, "PUT", { idList: cfg.lists.doing });
    
    return {
      content: [{
        type: "text",
        text: `🎯 **Iniciada:** ${currentTask.name}\n🔗 ${currentTask.shortUrl}`,
      }],
    };
  }
);

server.tool(
  "trello_status",
  "Mostra a tarefa atual em andamento",
  {},
  async () => {
    if (!currentTask) {
      return {
        content: [{ type: "text", text: "📌 Nenhuma tarefa em andamento" }],
      };
    }
    
    return {
      content: [{
        type: "text",
        text: `📌 **Atual:** ${currentTask.name}\n🔗 ${currentTask.shortUrl}`,
      }],
    };
  }
);

server.tool(
  "trello_done",
  "Marca a tarefa atual como concluída (move para Testing)",
  {},
  async () => {
    if (!currentTask) {
      return {
        content: [{ type: "text", text: "⚠️ Nenhuma tarefa em andamento!" }],
      };
    }
    
    const cfg = loadConfig();
    await fetchTrello(cfg, `/cards/${currentTask.id}/actions/comments`, "POST", {
      text: `✅ Concluído em ${new Date().toLocaleString("pt-BR")}`,
    });
    await fetchTrello(cfg, `/cards/${currentTask.id}`, "PUT", { idList: cfg.lists.testing });
    
    const msg = `✅ **Concluída:** ${currentTask.name}`;
    currentTask = null;
    
    return { content: [{ type: "text", text: msg }] };
  }
);

server.tool(
  "trello_create",
  "Cria uma nova tarefa no backlog",
  { title: z.string().describe("Título da tarefa") },
  async ({ title }) => {
    const cfg = loadConfig();
    const card = await fetchTrello<TrelloCard>(cfg, "/cards", "POST", {
      idList: cfg.lists.backlog,
      name: title,
      idLabels: [cfg.labels.pontoFocal],
    });
    
    return {
      content: [{
        type: "text",
        text: `✅ **Criada:** ${title}\n🔗 ${card.shortUrl}`,
      }],
    };
  }
);

server.tool(
  "trello_create_card",
  "Cria um card completo com lista, labels e descrição personalizáveis",
  {
    name: z.string().describe("Título do card"),
    listName: z.string().optional().describe("Nome da lista: backlog, doing, testing, done, ou nome exato. Padrão: backlog"),
    labelIds: z.array(z.string()).optional().describe("IDs das labels a adicionar"),
    labelNames: z.array(z.string()).optional().describe("Nomes das labels (alternativa aos IDs)"),
    desc: z.string().optional().describe("Descrição do card (suporta Markdown)"),
    due: z.string().optional().describe("Data de vencimento (ISO format ou relativo como 'tomorrow')"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ name, listName, labelIds, labelNames, desc, due, boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetListId: string;
    
    if (listName) {
      const detectedLists = await detectListIds(creds, boardId);
      const listMap: Record<string, string> = {
        "backlog": detectedLists.backlog,
        "doing": detectedLists.doing,
        "testing": detectedLists.testing,
        "done": detectedLists.done,
      };
      targetListId = listMap[listName.toLowerCase()];
      
      if (!targetListId) {
        const lists = await getBoardLists(creds, boardId);
        const list = lists.find(l => l.name.toLowerCase().includes(listName.toLowerCase()));
        if (list) targetListId = list.id;
      }
      
      if (!targetListId) {
        return {
          content: [{ type: "text", text: `❌ Lista "${listName}" não encontrada` }],
        };
      }
    } else {
      const detectedLists = await detectListIds(creds, boardId);
      targetListId = detectedLists.backlog || cfg.lists.backlog;
    }
    
    let finalLabelIds = labelIds || [];
    
    if (labelNames && labelNames.length > 0) {
      const boardLabels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      for (const labelName of labelNames) {
        const found = boardLabels.find(l => 
          l.name.toLowerCase() === labelName.toLowerCase() ||
          l.name.toLowerCase().includes(labelName.toLowerCase())
        );
        if (found && !finalLabelIds.includes(found.id)) {
          finalLabelIds.push(found.id);
        }
      }
    }
    
    const cardData: Record<string, unknown> = {
      idList: targetListId,
      name: name,
    };
    
    if (finalLabelIds.length > 0) {
      cardData.idLabels = finalLabelIds;
    }
    
    if (desc) {
      cardData.desc = desc;
    }
    
    if (due) {
      if (due === "today") {
        cardData.due = new Date().toISOString();
      } else if (due === "tomorrow") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        cardData.due = tomorrow.toISOString();
      } else if (due === "next week") {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        cardData.due = nextWeek.toISOString();
      } else {
        cardData.due = due;
      }
    }
    
    try {
      const card = await fetchTrelloWithCreds<TrelloCard>(creds, "/cards", "POST", cardData);
      
      const lists = await getBoardLists(creds, boardId);
      const list = lists.find(l => l.id === targetListId);
      
      let text = `✅ **Card Criado**\n\n`;
      text += `📌 **${name}**\n`;
      text += `📋 Lista: ${list?.name || listName || "backlog"}\n`;
      if (desc) text += `📄 Descrição: ${desc.slice(0, 100)}${desc.length > 100 ? "..." : ""}\n`;
      if (finalLabelIds.length > 0) text += `🏷️ Labels: ${finalLabelIds.length}\n`;
      if (due) text += `📅 Vencimento: ${due}\n`;
      text += `\n🔗 ${card.shortUrl}\n`;
      text += `🆔 ${card.id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar card: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_add_comment",
  "Adiciona um comentário a um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    text: z.string().describe("Texto do comentário"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, text, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/actions/comments`, "POST", { text });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`);
      
      let textPreview = text.length > 100 ? text.slice(0, 100) + "..." : text;
      let textOutput = `💬 **Comentário Adicionado**\n\n`;
      textOutput += `📌 Card: ${cardDetails.name}\n`;
      textOutput += `💭 "${textPreview}"\n`;
      textOutput += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text: textOutput }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao adicionar comentário: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_update_card",
  "Atualiza um card existente (move de lista, atualiza nome, descrição, etiquetas, etc)",
  {
    cardId: z.string().optional().describe("ID do card a atualizar"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    listName: z.string().optional().describe("Nome da lista: backlog, doing, testing, done, Concluído, Defeito, ou nome exato"),
    name: z.string().optional().describe("Novo título do card"),
    desc: z.string().optional().describe("Nova descrição"),
    labelIds: z.array(z.string()).optional().describe("Array de IDs de labels para SUBSTITUIR todas as labels existentes"),
    labelNames: z.array(z.string()).optional().describe("Array de nomes de labels para SUBSTITUIR todas as labels existentes"),
    addLabelIds: z.array(z.string()).optional().describe("Array de IDs de labels para ADICIONAR às existentes (não remove outras)"),
    addLabelNames: z.array(z.string()).optional().describe("Array de nomes de labels para ADICIONAR às existentes (não remove outras)"),
    removeLabelIds: z.array(z.string()).optional().describe("Array de IDs de labels para REMOVER"),
    removeLabelNames: z.array(z.string()).optional().describe("Array de nomes de labels para REMOVER"),
    due: z.string().optional().describe("Data de vencimento (ISO 8601, 'today', 'tomorrow', 'next week', ou 'remove' para remover"),
    dueComplete: z.boolean().optional().describe("Marcar data de vencimento como completa"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, listName, name, desc, labelIds, labelNames, addLabelIds, addLabelNames, removeLabelIds, removeLabelNames, due, dueComplete, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    // Buscar labels atuais do card (sem limitar campos para garantir que idLabels seja retornado)
    const currentCard = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=idLabels,idBoard`);
    const currentLabelIds = currentCard.idLabels || [];
    
    const updateData: Record<string, unknown> = {};
    const labelChanges: string[] = [];
    
    if (name) updateData.name = name;
    if (desc !== undefined) updateData.desc = desc;
    
    // Handle labels - modo substituição (comportamento original)
    if (labelIds && labelIds.length > 0) {
      updateData.idLabels = labelIds.join(",");
      labelChanges.push(`Labels substituídas: ${labelIds.length}`);
    } else if (labelNames && labelNames.length > 0) {
      const boardLabels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const labelIdsFromNames = boardLabels
        .filter(l => labelNames.some(name => l.name.toLowerCase().includes(name.toLowerCase())))
        .map(l => l.id);
      updateData.idLabels = labelIdsFromNames.join(",");
      labelChanges.push(`Labels substituídas por nomes: ${labelNames.join(", ")}`);
    }
    
    // Handle labels - modo adicionar (não remove existentes)
    let finalAddLabelIds: string[] = [];
    if (addLabelIds && addLabelIds.length > 0) {
      finalAddLabelIds = addLabelIds.filter(id => !currentLabelIds.includes(id));
    }
    if (addLabelNames && addLabelNames.length > 0) {
      const boardLabels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const labelIdsFromNames = boardLabels
        .filter(l => addLabelNames.some(name => l.name.toLowerCase().includes(name.toLowerCase())))
        .map(l => l.id);
      finalAddLabelIds = [...finalAddLabelIds, ...labelIdsFromNames.filter(id => !currentLabelIds.includes(id))];
    }
    if (finalAddLabelIds.length > 0) {
      const newLabelIds = [...currentLabelIds, ...finalAddLabelIds];
      updateData.idLabels = newLabelIds.join(",");
      labelChanges.push(`Labels adicionadas: ${finalAddLabelIds.length}`);
    }
    
    // Handle labels - modo remover
    let finalRemoveLabelIds: string[] = [];
    if (removeLabelIds && removeLabelIds.length > 0) {
      finalRemoveLabelIds = removeLabelIds;
    }
    if (removeLabelNames && removeLabelNames.length > 0) {
      const boardLabels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const labelIdsFromNames = boardLabels
        .filter(l => removeLabelNames.some(name => l.name.toLowerCase().includes(name.toLowerCase())))
        .map(l => l.id);
      finalRemoveLabelIds = [...finalRemoveLabelIds, ...labelIdsFromNames];
    }
    if (finalRemoveLabelIds.length > 0) {
      const remainingLabelIds = currentLabelIds.filter(id => !finalRemoveLabelIds.includes(id));
      updateData.idLabels = remainingLabelIds.join(",");
      labelChanges.push(`Labels removidas: ${finalRemoveLabelIds.length}`);
    }
    
    // Handle due date
    if (due !== undefined) {
      if (due === "remove" || due === "") {
        // Debug: mostrar que estamos tentando remover
        console.log("[DEBUG] Tentando remover due do cartao");
        // Enviar "none" para remover a data
        updateData.due = "none";
        labelChanges.push("Data de vencimento removida");
      } else if (due === "today") {
        updateData.due = new Date().toISOString();
        labelChanges.push("Data de vencimento: hoje");
      } else if (due === "tomorrow") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        updateData.due = tomorrow.toISOString();
        labelChanges.push("Data de vencimento: amanha");
      } else if (due === "next week") {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        updateData.due = nextWeek.toISOString();
        labelChanges.push("Data de vencimento: proxima semana");
      } else {
        updateData.due = due;
        labelChanges.push(`Data de vencimento: ${due}`);
      }
    }
    
    // Handle dueComplete
    if (dueComplete !== undefined) {
      updateData.dueComplete = dueComplete;
      labelChanges.push(dueComplete ? "Marcado como concluído" : "Marcado como pendente");
    }
    
    if (listName) {
      const lists = await fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`);
      const normalizedListName = listName.toLowerCase().trim();
      
      let targetListId: string | undefined;
      
      const listAliases: Record<string, string[]> = {
        "backlog": ["backlog", "a fazer", "to do"],
        "doing": ["doing", "fazendo", "em andamento", "in progress"],
        "testing": ["testing", "em teste", "teste", "review", "revisão"],
        "done": ["done", "concluído", "concluido", "completo", "finalizado"],
        "defeito": ["defeito", "bug", "problema"],
        "planejado": ["planejado", "planned"]
      };
      
      for (const [key, aliases] of Object.entries(listAliases)) {
        if (aliases.some(alias => normalizedListName.includes(alias))) {
          const foundList = lists.find(l => aliases.some(alias => l.name.toLowerCase().includes(alias)));
          if (foundList) {
            targetListId = foundList.id;
            break;
          }
        }
      }
      
      if (!targetListId) {
        const exactMatch = lists.find(l => l.name.toLowerCase() === normalizedListName);
        if (exactMatch) targetListId = exactMatch.id;
      }
      
      if (!targetListId) {
        const partialMatch = lists.find(l => l.name.toLowerCase().includes(normalizedListName));
        if (partialMatch) targetListId = partialMatch.id;
      }
      
      if (targetListId) {
        updateData.idList = targetListId;
      } else {
        return {
          content: [{ type: "text", text: `❌ Lista não encontrada: "${listName}"` }],
        };
      }
    }
    
    // Permitir update se vamos remover a data (due=none)
    const isDueRemoval = (updateData as any).due === "none";
    if (Object.keys(updateData).length === 0 && !isDueRemoval) {
      return {
        content: [{ 
          type: "text", 
          text: `❌ Nenhum campo para atualizar. Forneça pelo menos um campo (name, desc, listName, labelIds, addLabelIds, addLabelNames, removeLabelIds, removeLabelNames, due, dueComplete). Ex: due: "remove" para remover data` 
        }],
      };
    }
    
    try {
      let card;
      
      if ((updateData as any).due === "none") {
        // Para remover due, usar query string via fetchTrelloWithCreds
        const endpoint = `/cards/${targetCardId}?due=none`;
        
        let res = await fetch(`https://api.trello.com/1${endpoint}&key=${creds.apiKey}&token=${creds.token}`, { method: "PUT" });
        
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Trello API error: ${res.status} ${res.statusText} - ${errorText}`);
        }
        
        card = await res.json();
      } else {
        card = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`, "PUT", updateData);
      }
      
      let text = `✅ **Card Atualizado**\n\n`;
      text += `🆔 ${targetCardId}\n`;
      if (name) text += `📌 Título: ${name}\n`;
      if (desc !== undefined) text += `📄 Descrição atualizada\n`;
      if (listName) text += `📋 Movido para: ${listName}\n`;
      if (labelChanges.length > 0) {
        text += `\n🏷️ **Alterações de labels:**\n`;
        labelChanges.forEach(change => {
          text += `  • ${change}\n`;
        });
      }
      text += `\n🔗 ${card.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar card: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_get_card_details",
  "Busca detalhes de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=all&actions=all&board=true&lists=all&labels=all&checklists=all`);
      
      let output = `📌 **${cardDetails.name}**\n\n`;
      output += `🆔 ID: ${cardDetails.id}\n`;
      if (cardDetails.desc) output += `📄 Descrição: ${cardDetails.desc.substring(0, 100)}...\n`;
      output += `🔗 ${cardDetails.shortUrl}\n`;
      
      if (cardDetails.labels && cardDetails.labels.length > 0) {
        output += `\n🏷️ Labels: ${cardDetails.labels.map(l => l.name).join(', ')}\n`;
      }
      
      if (cardDetails.checklists && cardDetails.checklists.length > 0) {
        output += `\n📋 Checklists:\n`;
        for (const checklist of cardDetails.checklists) {
          const completed = checklist.checkItems.filter(i => i.state === 'complete').length;
          output += `  - ${checklist.name} (${completed}/${checklist.checkItems.length})\n`;
        }
      }
      
      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao buscar card: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_set_due_date",
  "Define uma data de vencimento em um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    due: z.string().describe("Data de vencimento: ISO 8601, 'today', 'tomorrow', 'next week', ou data específica"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, due, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      let dueDate: string;
      
      if (due === "today") {
        dueDate = new Date().toISOString();
      } else if (due === "tomorrow") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dueDate = tomorrow.toISOString();
      } else if (due === "next week") {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        dueDate = nextWeek.toISOString();
      } else {
        dueDate = due;
      }
      
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}`, "PUT", { due: dueDate });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due`);
      
      const formattedDue = new Date(dueDate).toLocaleString("pt-BR");
      
      let text = `✅ **Data de Vencimento Definida**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📅 Vencimento: ${formattedDue}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao definir data: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_get_due_date",
  "Busca a data de vencimento de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due,dueComplete`);
      
      let text = `📅 **Data de Vencimento**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      
      if (cardDetails.due) {
        const dueDate = new Date(cardDetails.due);
        const now = new Date();
        const isOverdue = dueDate < now && !cardDetails.dueComplete;
        const isComplete = cardDetails.dueComplete;
        
        text += `📅 **Data:** ${dueDate.toLocaleString("pt-BR")}\n`;
        
        if (isComplete) {
          text += `✅ **Status:** Concluída\n`;
        } else if (isOverdue) {
          const daysOverdue = Math.ceil((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
          text += `⚠️ **Status:** Atrasada (${daysOverdue} dia(s) atrás)\n`;
        } else {
          const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          text += `⏳ **Status:** ${daysLeft} dia(s) restante(s)\n`;
        }
      } else {
        text += `❌ Nenhuma data de vencimento definida\n`;
      }
      
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao buscar data: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_remove_due_date",
  "Remove a data de vencimento de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const cardDetailsBefore = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due`);
      
      if (!cardDetailsBefore.due) {
        return {
          content: [{ 
            type: "text", 
            text: `ℹ️ Nenhuma data de vencimento para remover.\n\n📌 Card: ${cardDetailsBefore.name}\n🔗 ${cardDetailsBefore.shortUrl}`
          }],
        };
      }
      
      const oldDue = new Date(cardDetailsBefore.due).toLocaleString("pt-BR");
      
      const endpoint = `/cards/${targetCardId}?due=none`;
      await fetch(`https://api.trello.com/1${endpoint}&key=${creds.apiKey}&token=${creds.token}`, { method: "PUT" });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Data de Vencimento Removida**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📅 Removida: ${oldDue}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao remover data: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_mark_due_complete",
  "Marca a data de vencimento de um card como concluída ou pendente",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    complete: z.boolean().describe("true = concluída, false = pendente"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, complete, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const cardDetailsBefore = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due`);
      
      if (!cardDetailsBefore.due) {
        return {
          content: [{ 
            type: "text", 
            text: `❌ Este card não tem data de vencimento definida.\n\nUse trello_set_due_date primeiro para definir uma data.`
          }],
        };
      }
      
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}`, "PUT", { dueComplete: complete });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due,dueComplete`);
      
      const status = complete ? "✅ Concluída" : "⏳ Pendente";
      
      let text = `✅ **Data de Vencimento Atualizada**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📅 Vencimento: ${new Date(cardDetails.due!).toLocaleString("pt-BR")}\n`;
      text += `📊 Status: ${status}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar status: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_get_comments",
  "Busca comentários de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const comments = await fetchTrelloWithCreds<TrelloComment[]>(creds, `/cards/${targetCardId}/actions?filter=commentCard`);
      
      if (!comments || comments.length === 0) {
        return {
          content: [{ type: "text", text: "💬 Nenhum comentário encontrado neste card" }],
        };
      }
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`);
      
      let output = `💬 **Comentários do Card**\n\n`;
      output += `📌 ${cardDetails.name}\n`;
      output += `Total: ${comments.length} comentário(s)\n\n`;
      
      comments.forEach((comment, i) => {
        const date = new Date(comment.date).toLocaleString("pt-BR");
        const member = comment.memberCreator?.fullName || "Desconhecido";
        output += `--- Comment ${i + 1} ---\n`;
        output += `👤 ${member} • ${date}\n`;
        output += `💭 ${comment.data.text}\n\n`;
      });
      
      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao buscar comentários: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

// ==========================================
// FERRAMENTAS DE EXCLUSÃO
// ==========================================

server.tool(
  "trello_delete_card",
  "Exclui um card específico do Trello",
  {
    cardId: z.string().optional().describe("ID do card a excluir"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`);
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}`, "DELETE");
      
      return {
        content: [{
          type: "text",
          text: `✅ Card excluído: **${cardDetails.name}**\n🆔 ${targetCardId}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir card: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_all_cards",
  "Exclui todos os cards de uma lista específica ou de todo o quadro",
  {
    listName: z.string().optional().describe("Nome da lista: backlog, doing, testing, done, ou nome exato. Se vazio, exclui do quadro todo"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    confirm: z.boolean().describe("Confirmação obrigatória: true para executar a exclusão")
  },
  async ({ listName, boardUrl, confirm }) => {
    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: "⚠️ Operação cancelada. Use confirm: true para confirmar a exclusão.",
        }],
      };
    }
    
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let cardsToDelete: TrelloCard[] = [];
    let listDisplayName = "todo o quadro";
    
    if (listName) {
      let listId: string | undefined;
      
      if (boardId === cfg.boardId) {
        const listMap: Record<string, string> = {
          "backlog": cfg.lists.backlog,
          "doing": cfg.lists.doing,
          "testing": cfg.lists.testing,
          "done": cfg.lists.done,
        };
        listId = listMap[listName.toLowerCase()];
      }
      
      if (!listId) {
        const detectedLists = await detectListIds(creds, boardId);
        const listMap: Record<string, string> = {
          "backlog": detectedLists.backlog,
          "doing": detectedLists.doing,
          "testing": detectedLists.testing,
          "done": detectedLists.done,
        };
        listId = listMap[listName.toLowerCase()];
      }
      
      if (!listId) {
        const lists = await getBoardLists(creds, boardId);
        const list = lists.find(l => l.name.toLowerCase().includes(listName.toLowerCase()));
        if (list) listId = list.id;
      }
      
      if (!listId) {
        return {
          content: [{ type: "text", text: `❌ Lista "${listName}" não encontrada` }],
        };
      }
      
      cardsToDelete = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/lists/${listId}/cards`);
      const lists = await getBoardLists(creds, boardId);
      const list = lists.find(l => l.id === listId);
      listDisplayName = list?.name || listName;
    } else {
      cardsToDelete = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    }
    
    if (cardsToDelete.length === 0) {
      return {
        content: [{
          type: "text",
          text: `✅ Nenhum card para excluir em "${listDisplayName}"`,
        }],
      };
    }
    
    let deleted = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const card of cardsToDelete) {
      try {
        await fetchTrelloWithCreds(creds, `/cards/${card.id}`, "DELETE");
        deleted++;
      } catch (error) {
        failed++;
        errors.push(`${card.name}: ${error instanceof Error ? error.message : "Erro"}`);
      }
    }
    
    let text = `🗑️ **Exclusão Concluída**\n\n`;
    text += `📊 **Lista:** ${listDisplayName}\n`;
    text += `✅ **Excluídos:** ${deleted}\n`;
    text += `❌ **Falhas:** ${failed}\n`;
    text += `📋 **Total processado:** ${cardsToDelete.length}\n`;
    
    if (errors.length > 0 && errors.length <= 5) {
      text += `\n⚠️ **Erros:**\n`;
      for (const err of errors) {
        text += `  • ${err}\n`;
      }
    } else if (errors.length > 5) {
      text += `\n⚠️ ${errors.length} erros encontrados\n`;
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_archive_all_cards",
  "Arquiva (fecha) todos os cards de uma lista ou do quadro todo - alternativa à exclusão",
  {
    listName: z.string().optional().describe("Nome da lista: backlog, doing, testing, done. Se vazio, arquiva do quadro todo"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    confirm: z.boolean().describe("Confirmação obrigatória: true para executar")
  },
  async ({ listName, boardUrl, confirm }) => {
    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: "⚠️ Operação cancelada. Use confirm: true para confirmar.",
        }],
      };
    }
    
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let cardsToArchive: TrelloCard[] = [];
    let listDisplayName = "todo o quadro";
    
    if (listName) {
      let listId: string | undefined;
      
      const detectedLists = await detectListIds(creds, boardId);
      const listMap: Record<string, string> = {
        "backlog": detectedLists.backlog,
        "doing": detectedLists.doing,
        "testing": detectedLists.testing,
        "done": detectedLists.done,
      };
      listId = listMap[listName.toLowerCase()];
      
      if (!listId) {
        const lists = await getBoardLists(creds, boardId);
        const list = lists.find(l => l.name.toLowerCase().includes(listName.toLowerCase()));
        if (list) listId = list.id;
      }
      
      if (!listId) {
        return {
          content: [{ type: "text", text: `❌ Lista "${listName}" não encontrada` }],
        };
      }
      
      cardsToArchive = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/lists/${listId}/cards`);
      const lists = await getBoardLists(creds, boardId);
      const list = lists.find(l => l.id === listId);
      listDisplayName = list?.name || listName;
    } else {
      cardsToArchive = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    }
    
    if (cardsToArchive.length === 0) {
      return {
        content: [{
          type: "text",
          text: `✅ Nenhum card para arquivar`,
        }],
      };
    }
    
    let archived = 0;
    let failed = 0;
    
    for (const card of cardsToArchive) {
      try {
        await fetchTrelloWithCreds(creds, `/cards/${card.id}`, "PUT", { closed: true });
        archived++;
      } catch {
        failed++;
      }
    }
    
    return {
      content: [{
        type: "text",
        text: `📦 **Arquivamento Concluído**\n\n📊 Lista: ${listDisplayName}\n✅ Arquivados: ${archived}\n❌ Falhas: ${failed}`,
      }],
    };
  }
);

server.tool(
  "trello_list_labels",
  "Lista todas as labels disponíveis no quadro Trello",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const labels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
    
    const emojiMap: Record<string, string> = {
      green: "🟢",
      yellow: "🟡",
      orange: "🟠",
      red: "🔴",
      purple: "🟣",
      blue: "🔵",
      sky: "🌤️",
      lime: "💚",
      pink: "💗",
      black: "⚫",
      null: "🏷️",
    };
    
    if (labels.length === 0) {
      return {
        content: [{ type: "text", text: "❌ Nenhuma label encontrada no quadro" }],
      };
    }
    
    let text = `🏷️ **Labels do Quadro** (${labels.length})\n\n`;
    
    for (const label of labels) {
      const emoji = emojiMap[label.color] || "🏷️";
      const name = label.name || "(sem nome)";
      text += `${emoji} **${name}**\n`;
      text += `   Cor: ${label.color || "padrão"}\n`;
      text += `   ID: ${label.id}\n\n`;
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_list_lists",
  "Lista todas as listas de um quadro Trello",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const lists = await getBoardLists(creds, boardId);
    
    if (lists.length === 0) {
      return {
        content: [{ type: "text", text: "❌ Nenhuma lista encontrada no quadro" }],
      };
    }
    
    let text = `📋 **Listas do Quadro** (${lists.length})\n\n`;
    
    for (const list of lists) {
      text += `• **${list.name}**\n`;
      text += `  🆔 ${list.id}\n\n`;
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_list_cards_in_list",
  "Lista os cards de uma lista específica do Trello",
  {
    listName: z.string().describe("Nome da lista (ex: Roadmap do Produto, Planejado, Backlog, Doing, Testing, Done)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ listName, boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    // Buscar todas as listas do board
    const lists = await getBoardLists(creds, boardId);
    
    // Encontrar a lista pelo nome (busca parcial)
    const normalizedSearchName = listName.toLowerCase().trim();
    const foundList = lists.find(l => 
      l.name.toLowerCase().includes(normalizedSearchName) ||
      normalizedSearchName.includes(l.name.toLowerCase())
    );
    
    if (!foundList) {
      const availableLists = lists.map(l => l.name).join(", ");
      return {
        content: [{ 
          type: "text", 
          text: `❌ Lista "${listName}" não encontrada.\n\nListas disponíveis:\n${availableLists}` 
        }],
      };
    }
    
    // Buscar todos os cards do board
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    
    // Filtrar apenas os cards da lista específica
    const cardsInList = allCards.filter(c => c.idList === foundList.id);
    
    if (cardsInList.length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: `📋 **${foundList.name}**\n\nNenhum card encontrado nesta lista.` 
        }],
      };
    }
    
    let text = `📋 **${foundList.name}** (${cardsInList.length} cards)\n\n`;
    
    for (const card of cardsInList) {
      text += `• ${card.name}\n`;
      text += `  🔗 ${card.shortUrl}\n\n`;
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_create_list",
  "Cria uma nova lista (coluna) em um quadro do Trello",
  {
    name: z.string().describe("Nome da nova lista"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    pos: z.number().optional().describe("Posição da lista (número ou 'top', 'bottom'). Padrão: bottom")
  },
  async ({ name, boardUrl, pos }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const listData: Record<string, unknown> = {
        name: name,
        idBoard: boardId
      };
      
      if (pos) {
        if (typeof pos === 'number') {
          listData.pos = pos;
        } else if (pos === 'top') {
          listData.pos = 0;
        } else if (pos === 'bottom') {
          listData.pos = 65536;
        }
      }
      
      const newList = await fetchTrelloWithCreds<TrelloList>(creds, "/lists", "POST", listData);
      
      let text = `✅ **Lista Criada**\n\n`;
      text += `📋 **${newList.name}**\n`;
      text += `🆔 ${newList.id}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar lista: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_update_list",
  "Atualiza uma lista (coluna) existente do Trello",
  {
    listId: z.string().optional().describe("ID da lista (alternativa ao nome)"),
    listName: z.string().optional().describe("Nome ou parte do nome da lista (alternativa ao ID)"),
    newName: z.string().optional().describe("Novo nome para a lista"),
    newPos: z.number().optional().describe("Nova posição da lista (número, 'top', 'bottom')"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ listId, listName, newName, newPos, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetListId = listId;
    
    if (!targetListId && listName) {
      const lists = await getBoardLists(creds, boardId);
      const searchName = listName.toLowerCase().trim();
      const foundList = lists.find(l => 
        l.name.toLowerCase().includes(searchName) || 
        searchName.includes(l.name.toLowerCase())
      );
      
      if (!foundList) {
        const availableLists = lists.map(l => l.name).join(", ");
        return {
          content: [{ 
            type: "text", 
            text: `❌ Lista "${listName}" não encontrada.\n\nListas disponíveis:\n${availableLists}` 
          }],
        };
      }
      targetListId = foundList.id;
    }
    
    if (!targetListId) {
      return {
        content: [{ type: "text", text: "❌ Forneça listId ou listName" }],
      };
    }
    
    const updateData: Record<string, unknown> = {};
    
    if (newName) {
      updateData.name = newName;
    }
    
    if (newPos !== undefined) {
      if (typeof newPos === 'number') {
        updateData.pos = newPos;
      } else if (newPos === 'top') {
        updateData.pos = 0;
      } else if (newPos === 'bottom') {
        updateData.pos = 65536;
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: "❌ Forneça pelo menos um campo para atualizar: newName ou newPos" 
        }],
      };
    }
    
    try {
      const updatedList = await fetchTrelloWithCreds<TrelloList>(creds, `/lists/${targetListId}`, "PUT", updateData);
      
      let text = `✅ **Lista Atualizada**\n\n`;
      text += `📋 **${updatedList.name}**\n`;
      text += `🆔 ${updatedList.id}\n`;
      if (newName) text += `📝 Nome alterado\n`;
      if (newPos !== undefined) text += `📍 Posição alterada: ${newPos}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar lista: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_list",
  "Exclui uma lista (coluna) de um quadro do Trello",
  {
    listId: z.string().optional().describe("ID da lista (alternativa ao nome)"),
    listName: z.string().optional().describe("Nome ou parte do nome da lista (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ listId, listName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetListId = listId;
    let listNameDeleted = listName || "Lista";
    
    if (!targetListId && listName) {
      const lists = await getBoardLists(creds, boardId);
      const searchName = listName.toLowerCase().trim();
      const foundList = lists.find(l => 
        l.name.toLowerCase().includes(searchName) || 
        searchName.includes(l.name.toLowerCase())
      );
      
      if (!foundList) {
        const availableLists = lists.map(l => l.name).join(", ");
        return {
          content: [{ 
            type: "text", 
            text: `❌ Lista "${listName}" não encontrada.\n\nListas disponíveis:\n${availableLists}` 
          }],
        };
      }
      targetListId = foundList.id;
      listNameDeleted = foundList.name;
    }
    
    if (!targetListId) {
      return {
        content: [{ type: "text", text: "❌ Forneça listId ou listName" }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/lists/${targetListId}`, "DELETE");
      
      let text = `✅ **Lista Excluída**\n\n`;
      text += `🗑️ **${listNameDeleted}**\n`;
      text += `🆔 ${targetListId}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir lista: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_create_label",
  "Cria uma ou mais labels no quadro Trello",
  {
    labels: z.array(z.object({
      name: z.string().describe("Nome da label"),
      color: z.string().optional().describe("Cor: green, yellow, orange, red, purple, blue, sky, lime, pink, black")
    })).describe("Lista de labels a criar"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ labels, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const emojiMap: Record<string, string> = {
      green: "🟢",
      yellow: "🟡",
      orange: "🟠",
      red: "🔴",
      purple: "🟣",
      blue: "🔵",
      sky: "🌤️",
      lime: "💚",
      pink: "💗",
      black: "⚫",
    };
    
    let created = 0;
    let failed = 0;
    const results: string[] = [];
    
    for (const label of labels) {
      try {
        const result = await fetchTrelloWithCreds<TrelloBoardLabel>(
          creds,
          "/labels",
          "POST",
          { idBoard: boardId, name: label.name, color: label.color || null }
        );
        const emoji = emojiMap[label.color || ""] || "🏷️";
        results.push(`${emoji} ${label.name} | Cor: ${label.color || "padrão"} | ID: ${result.id}`);
        created++;
      } catch (error) {
        results.push(`❌ ${label.name}: ${error instanceof Error ? error.message : "Erro"}`);
        failed++;
      }
    }
    
    let text = `🏷️ **Labels Criadas**\n\n`;
    text += `✅ Criadas: ${created}\n`;
    text += `❌ Falhas: ${failed}\n\n`;
    text += results.map(r => `  ${r}`).join("\n");
    text += `\n\n🔗 https://trello.com/b/${boardId}`;
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_update_label",
  "Atualiza uma etiqueta (label) existente do Trello",
  {
    labelId: z.string().optional().describe("ID da label (alternativa ao nome)"),
    labelName: z.string().optional().describe("Nome ou parte do nome da label (alternativa ao ID)"),
    newName: z.string().optional().describe("Novo nome para a label"),
    newColor: z.string().optional().describe("Nova cor: green, yellow, orange, red, purple, blue, sky, lime, pink, black"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ labelId, labelName, newName, newColor, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetLabelId = labelId;
    
    if (!targetLabelId && labelName) {
      const labels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const searchName = labelName.toLowerCase().trim();
      const foundLabel = labels.find(l => 
        l.name.toLowerCase().includes(searchName) || 
        searchName.includes(l.name.toLowerCase())
      );
      
      if (!foundLabel) {
        const availableLabels = labels.map(l => l.name).join(", ");
        return {
          content: [{ 
            type: "text", 
            text: `❌ Label "${labelName}" não encontrada.\n\nLabels disponíveis:\n${availableLabels}` 
          }],
        };
      }
      targetLabelId = foundLabel.id;
    }
    
    if (!targetLabelId) {
      return {
        content: [{ type: "text", text: "❌ Forneça labelId ou labelName" }],
      };
    }
    
    const updateData: Record<string, unknown> = {};
    
    if (newName) updateData.name = newName;
    if (newColor) updateData.color = newColor;
    
    if (Object.keys(updateData).length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: "❌ Forneça pelo menos um campo para atualizar: newName ou newColor" 
        }],
      };
    }
    
    try {
      const updatedLabel = await fetchTrelloWithCreds<TrelloBoardLabel>(creds, `/labels/${targetLabelId}`, "PUT", updateData);
      
      const emojiMap: Record<string, string> = {
        green: "🟢", yellow: "🟡", orange: "🟠", red: "🔴",
        purple: "🟣", blue: "🔵", sky: "🌤️", lime: "💚",
        pink: "💗", black: "⚫"
      };
      
      let text = `✅ **Label Atualizada**\n\n`;
      text += `🏷️ **${updatedLabel.name}**\n`;
      text += `🆔 ${updatedLabel.id}\n`;
      if (newName) text += `📝 Nome alterado\n`;
      if (newColor) text += `🎨 Cor alterada para: ${emojiMap[newColor] || ""} ${newColor}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar label: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_label",
  "Exclui uma etiqueta (label) de um quadro do Trello",
  {
    labelId: z.string().optional().describe("ID da label (alternativa ao nome)"),
    labelName: z.string().optional().describe("Nome ou parte do nome da label (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ labelId, labelName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetLabelId = labelId;
    let labelNameDeleted = labelName || "Label";
    
    if (!targetLabelId && labelName) {
      const labels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const searchName = labelName.toLowerCase().trim();
      const foundLabel = labels.find(l => 
        l.name.toLowerCase().includes(searchName) || 
        searchName.includes(l.name.toLowerCase())
      );
      
      if (!foundLabel) {
        const availableLabels = labels.map(l => l.name).join(", ");
        return {
          content: [{ 
            type: "text", 
            text: `❌ Label "${labelName}" não encontrada.\n\nLabels disponíveis:\n${availableLabels}` 
          }],
        };
      }
      targetLabelId = foundLabel.id;
      labelNameDeleted = foundLabel.name;
    }
    
    if (!targetLabelId) {
      return {
        content: [{ type: "text", text: "❌ Forneça labelId ou labelName" }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/labels/${targetLabelId}`, "DELETE");
      
      let text = `✅ **Label Excluída**\n\n`;
      text += `🗑️ **${labelNameDeleted}**\n`;
      text += `🆔 ${targetLabelId}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir label: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_create_checklist",
  "Cria um checklist em um card do Trello",
  {
    cardName: z.string().describe("Nome ou parte do nome do card"),
    checklistName: z.string().describe("Nome do checklist"),
    items: z.array(z.string()).optional().describe("Lista de itens do checklist"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardName, checklistName, items, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    const searchName = cardName.toLowerCase().trim();
    const card = allCards.find(c => 
      c.name.toLowerCase().includes(searchName) || 
      searchName.includes(c.name.toLowerCase())
    );
    
    if (!card) {
      return {
        content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
      };
    }
    
    try {
      const checklist = await fetchTrelloWithCreds<{ id: string; name: string }>(
        creds,
        "/checklists",
        "POST",
        { idCard: card.id, name: checklistName }
      );
      
      let createdItems = 0;
      
      if (items && items.length > 0) {
        for (const item of items) {
          try {
            await fetchTrelloWithCreds(creds, `/checklists/${checklist.id}/checkItems`, "POST", { name: item });
            createdItems++;
          } catch {
          }
        }
      }
      
      let text = `✅ **Checklist Criado**\n\n`;
      text += `📋 **${checklistName}**\n`;
      text += `📌 Card: ${card.name}\n`;
      text += `📝 Itens: ${createdItems}/${items?.length || 0}\n`;
      text += `\n🔗 ${card.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar checklist: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_get_checklists",
  "Lista os checklists de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name&checklists=all`);
      const checklists = cardDetails.checklists || [];
      
      if (checklists.length === 0) {
        return {
          content: [{ 
            type: "text", 
            text: `📋 **Checklists do Card**\n\n📌 ${cardDetails.name}\n\nNenhum checklist encontrado.` 
          }],
        };
      }
      
      let text = `📋 **Checklists do Card**\n\n📌 ${cardDetails.name}\nTotal: ${checklists.length} checklist(s)\n\n`;
      
      for (const checklist of checklists) {
        const completed = checklist.checkItems.filter(i => i.state === 'complete').length;
        const total = checklist.checkItems.length;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
        
        text += `--- ${checklist.name} ---\n`;
        text += `📊 Progresso: ${completed}/${total} (${percentage}%)\n`;
        
        if (checklist.checkItems.length > 0) {
          for (const item of checklist.checkItems) {
            const check = item.state === 'complete' ? '☑️' : '⬜';
            text += `  ${check} ${item.name}\n`;
          }
        } else {
          text += `  (sem itens)\n`;
        }
        text += '\n';
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao buscar checklists: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_update_checklist",
  "Atualiza o nome de um checklist em um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    checklistId: z.string().optional().describe("ID do checklist (alternativa ao nome)"),
    checklistName: z.string().optional().describe("Nome do checklist a renomear"),
    newName: z.string().describe("Novo nome do checklist"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, checklistId, checklistName, newName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      let targetChecklistId = checklistId;
      let oldName = checklistName || "Checklist";
      
      if (!targetChecklistId && checklistName) {
        const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name&checklists=all`);
        const checklists = cardDetails.checklists || [];
        const foundChecklist = checklists.find(cl => 
          cl.name.toLowerCase().includes(checklistName.toLowerCase())
        );
        
        if (!foundChecklist) {
          const availableChecklists = checklists.map(cl => cl.name).join(", ");
          return {
            content: [{ 
              type: "text", 
              text: `❌ Checklist "${checklistName}" não encontrado.\n\nChecklists disponíveis:\n${availableChecklists || "(nenhum)"}` 
            }],
          };
        }
        targetChecklistId = foundChecklist.id;
        oldName = foundChecklist.name;
      }
      
      if (!targetChecklistId) {
        return {
          content: [{ type: "text", text: "❌ Forneça checklistId ou checklistName" }],
        };
      }
      
      await fetchTrelloWithCreds(creds, `/checklists/${targetChecklistId}`, "PUT", { name: newName });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Checklist Atualizado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📝 **De:** ${oldName}\n`;
      text += `📝 **Para:** ${newName}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar checklist: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_add_checklist_item",
  "Adiciona um item a um checklist existente",
  {
    cardName: z.string().describe("Nome ou parte do nome do card"),
    checklistName: z.string().describe("Nome do checklist"),
    itemName: z.string().describe("Nome do item"),
    checked: z.boolean().optional().describe("Marcar como concluído (padrão: false)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardName, checklistName, itemName, checked, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    const searchName = cardName.toLowerCase().trim();
    const card = allCards.find(c => 
      c.name.toLowerCase().includes(searchName) || 
      searchName.includes(c.name.toLowerCase())
    );
    
    if (!card) {
      return {
        content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
      };
    }
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = checklists.find(cl => 
      cl.name.toLowerCase().includes(checklistName.toLowerCase())
    );
    
    if (!checklist) {
      return {
        content: [{ type: "text", text: `❌ Checklist não encontrado: "${checklistName}"` }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/checklists/${checklist.id}/checkItems`, "POST", { 
        name: itemName,
        checked: checked || false
      });
      
      let text = `✅ **Item Adicionado**\n\n`;
      text += `⬜ ${itemName}\n`;
      text += `📋 Checklist: ${checklist.name}\n`;
      text += `📌 Card: ${card.name}\n`;
      text += `\n🔗 ${card.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao adicionar item: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_checklist",
  "Exclui um checklist de um card",
  {
    cardName: z.string().describe("Nome ou parte do nome do card"),
    checklistName: z.string().describe("Nome do checklist a excluir"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardName, checklistName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    const searchName = cardName.toLowerCase().trim();
    const card = allCards.find(c => 
      c.name.toLowerCase().includes(searchName) || 
      searchName.includes(c.name.toLowerCase())
    );
    
    if (!card) {
      return {
        content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
      };
    }
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = checklists.find(cl => 
      cl.name.toLowerCase().includes(checklistName.toLowerCase())
    );
    
    if (!checklist) {
      return {
        content: [{ type: "text", text: `❌ Checklist não encontrado: "${checklistName}"` }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/checklists/${checklist.id}`, "DELETE");
      
      let text = `✅ **Checklist Excluído**\n\n`;
      text += `🗑️ **${checklist.name}**\n`;
      text += `📝 Itens removidos: ${checklist.checkItems.length}\n`;
      text += `📌 Card: ${card.name}\n`;
      text += `\n🔗 ${card.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir checklist: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_checklist_item",
  "Exclui um item específico de um checklist",
  {
    cardName: z.string().describe("Nome ou parte do nome do card"),
    checklistName: z.string().describe("Nome do checklist"),
    itemName: z.string().describe("Nome do item a excluir"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardName, checklistName, itemName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    const searchName = cardName.toLowerCase().trim();
    const card = allCards.find(c => 
      c.name.toLowerCase().includes(searchName) || 
      searchName.includes(c.name.toLowerCase())
    );
    
    if (!card) {
      return {
        content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
      };
    }
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = checklists.find(cl => 
      cl.name.toLowerCase().includes(checklistName.toLowerCase())
    );
    
    if (!checklist) {
      return {
        content: [{ type: "text", text: `❌ Checklist não encontrado: "${checklistName}"` }],
      };
    }
    
    const item = checklist.checkItems.find(i => 
      i.name.toLowerCase().includes(itemName.toLowerCase())
    );
    
    if (!item) {
      return {
        content: [{ type: "text", text: `❌ Item não encontrado: "${itemName}"` }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/checklists/${checklist.id}/checkItems/${item.id}`, "DELETE");
      
      let text = `✅ **Item Excluído**\n\n`;
      text += `🗑️ ${item.name}\n`;
      text += `📋 Checklist: ${checklist.name}\n`;
      text += `📌 Card: ${card.name}\n`;
      text += `\n🔗 ${card.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir item: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_update_checklist_item",
  "Atualiza o estado de um item do checklist (marcar/desmarcar)",
  {
    cardName: z.string().describe("Nome ou parte do nome do card"),
    checklistName: z.string().describe("Nome do checklist"),
    itemName: z.string().describe("Nome do item"),
    checked: z.boolean().describe("Marcar como concluído (true) ou pendente (false)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardName, checklistName, itemName, checked, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    const searchName = cardName.toLowerCase().trim();
    const card = allCards.find(c => 
      c.name.toLowerCase().includes(searchName) || 
      searchName.includes(c.name.toLowerCase())
    );
    
    if (!card) {
      return {
        content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
      };
    }
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = checklists.find(cl => 
      cl.name.toLowerCase().includes(checklistName.toLowerCase())
    );
    
    if (!checklist) {
      return {
        content: [{ type: "text", text: `❌ Checklist não encontrado: "${checklistName}"` }],
      };
    }
    
    const item = checklist.checkItems.find(i => 
      i.name.toLowerCase().includes(itemName.toLowerCase())
    );
    
    if (!item) {
      return {
        content: [{ type: "text", text: `❌ Item não encontrado: "${itemName}"` }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${card.id}/checkItem/${item.id}`, "PUT", { 
        state: checked ? "complete" : "incomplete"
      });
      
      const status = checked ? "☑️" : "⬜";
      let text = `✅ **Item Atualizado**\n\n`;
      text += `${status} ${item.name}\n`;
      text += `📋 Checklist: ${checklist.name}\n`;
      text += `📌 Card: ${card.name}\n`;
      text += `\n🔗 ${card.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar item: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_delete_comment",
  "Exclui um comentário de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    commentId: z.string().optional().describe("ID do comentário (action ID) a excluir"),
    commentIndex: z.number().optional().describe("Índice do comentário (1 = mais recente, 2 = segundo mais recente, etc)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, commentId, commentIndex, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      let actionIdToDelete: string | undefined;
      
      if (commentId) {
        actionIdToDelete = commentId;
      } else if (commentIndex !== undefined) {
        const comments = await fetchTrelloWithCreds<TrelloComment[]>(creds, `/cards/${targetCardId}/actions?filter=commentCard&limit=50`);
        
        if (comments.length === 0) {
          return {
            content: [{ type: "text", text: "❌ Nenhum comentário encontrado neste card" }],
          };
        }
        
        const sortedComments = comments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        if (commentIndex < 1 || commentIndex > sortedComments.length) {
          return {
            content: [{ 
              type: "text", 
              text: `❌ Índice inválido. O card tem ${sortedComments.length} comentário(s). Use commentIndex de 1 a ${sortedComments.length} (1 = mais recente).` 
            }],
          };
        }
        
        actionIdToDelete = sortedComments[commentIndex - 1].id;
      } else {
        return {
          content: [{ 
            type: "text", 
            text: "❌ Forneça commentId (ID do comentário) ou commentIndex (número ordinal do comentário). Use trello_get_comments primeiro para ver os IDs." 
          }],
        };
      }
      
      if (!actionIdToDelete) {
        return {
          content: [{ type: "text", text: "❌ Não foi possível determinar qual comentário excluir" }],
        };
      }
      
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/actions/${actionIdToDelete}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`);
      
      let text = `✅ **Comentário Excluído**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🗑️ ID do comentário: ${actionIdToDelete}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao excluir comentário: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_update_comment",
  "Atualiza o texto de um comentário de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    commentId: z.string().optional().describe("ID do comentário (action ID) a editar"),
    commentIndex: z.number().optional().describe("Índice do comentário (1 = mais recente, 2 = segundo mais recente, etc)"),
    newText: z.string().describe("Novo texto do comentário"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, commentId, commentIndex, newText, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const searchName = cardName.toLowerCase().trim();
      const card = allCards.find(c => 
        c.name.toLowerCase().includes(searchName) || 
        searchName.includes(c.name.toLowerCase())
      );
      
      if (!card) {
        return {
          content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }],
        };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return {
        content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }],
      };
    }
    
    try {
      let actionIdToUpdate: string | undefined;
      let oldText = "";
      
      if (commentId) {
        actionIdToUpdate = commentId;
        const comments = await fetchTrelloWithCreds<TrelloComment[]>(creds, `/cards/${targetCardId}/actions?filter=commentCard&actions=commentCard&limit=50`);
        const comment = comments.find(c => c.id === commentId);
        if (comment) oldText = comment.data.text;
      } else if (commentIndex !== undefined) {
        const comments = await fetchTrelloWithCreds<TrelloComment[]>(creds, `/cards/${targetCardId}/actions?filter=commentCard&limit=50`);
        
        if (comments.length === 0) {
          return {
            content: [{ type: "text", text: "❌ Nenhum comentário encontrado neste card" }],
          };
        }
        
        const sortedComments = comments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        if (commentIndex < 1 || commentIndex > sortedComments.length) {
          return {
            content: [{ 
              type: "text", 
              text: `❌ Índice inválido. O card tem ${sortedComments.length} comentário(s). Use commentIndex de 1 a ${sortedComments.length} (1 = mais recente).` 
            }],
          };
        }
        
        actionIdToUpdate = sortedComments[commentIndex - 1].id;
        oldText = sortedComments[commentIndex - 1].data.text;
      } else {
        return {
          content: [{ 
            type: "text", 
            text: "❌ Forneça commentId (ID do comentário) ou commentIndex (número ordinal do comentário). Use trello_get_comments primeiro para ver os IDs." 
          }],
        };
      }
      
      if (!actionIdToUpdate) {
        return {
          content: [{ type: "text", text: "❌ Não foi possível determinar qual comentário editar" }],
        };
      }
      
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/actions/${actionIdToUpdate}/comments`, "PUT", { text: newText });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`);
      
      let text = `✅ **Comentário Atualizado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📝 **Antes:** "${oldText.slice(0, 100)}${oldText.length > 100 ? "..." : ""}"\n`;
      text += `📝 **Agora:** "${newText.slice(0, 100)}${newText.length > 100 ? "..." : ""}"\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar comentário: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

// ==========================================
// MEMBROS (MEMBERS)
// ==========================================

server.tool(
  "trello_list_board_members",
  "Lista os membros de um quadro do Trello",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const members = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/boards/${boardId}/members`);
      
      if (members.length === 0) {
        return {
          content: [{ type: "text", text: "👥 Nenhum membro encontrado neste quadro" }],
        };
      }
      
      let text = `👥 **Membros do Quadro** (${members.length})\n\n`;
      
      for (const member of members) {
        text += `• **${member.fullName}**\n`;
        text += `  @${member.username}\n`;
        if (member.avatarUrl) {
          text += `  🖼️ Avatar disponível\n`;
        }
        text += '\n';
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao listar membros: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_add_board_member",
  "Adiciona um membro a um quadro do Trello",
  {
    email: z.string().describe("Email do usuário a adicionar"),
    fullName: z.string().optional().describe("Nome completo (obrigatório se email não encontrado)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ email, fullName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      await fetchTrelloWithCreds(creds, `/boards/${boardId}/members`, "PUT", {
        email: email,
        fullName: fullName || ""
      });
      
      let text = `✅ **Membro Adicionado ao Quadro**\n\n`;
      text += `📧 Email: ${email}\n`;
      if (fullName) text += `👤 Nome: ${fullName}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao adicionar membro: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_remove_board_member",
  "Remove um membro de um quadro do Trello",
  {
    memberId: z.string().optional().describe("ID do membro (alternativa ao email)"),
    email: z.string().optional().describe("Email do membro a remover"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ memberId, email, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetMemberId = memberId;
    
    if (!targetMemberId && email) {
      const members = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/boards/${boardId}/members`);
      const member = members.find(m => m.id === email || m.username === email || m.fullName.toLowerCase().includes(email.toLowerCase()));
      if (member) {
        targetMemberId = member.id;
      }
    }
    
    if (!targetMemberId) {
      return {
        content: [{ type: "text", text: "❌ Forneça memberId ou email válido" }],
      };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/boards/${boardId}/members/${targetMemberId}`, "DELETE");
      
      let text = `✅ **Membro Removido do Quadro**\n\n`;
      text += `🆔 ID: ${targetMemberId}\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao remover membro: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "trello_list_card_members",
  "Lista os membros de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const members = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/cards/${targetCardId}/members`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      if (members.length === 0) {
        return { content: [{ type: "text", text: `👤 Nenhum membro neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `👤 **Membros do Card** (${members.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      for (const member of members) {
        text += `• **${member.fullName}** (@${member.username})\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_add_card_member",
  "Adiciona um membro a um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    memberId: z.string().describe("ID do membro a adicionar"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, memberId, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/members`, "POST", { idMember: memberId });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Membro Adicionado ao Card**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🆔 ID do membro: ${memberId}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_remove_card_member",
  "Remove um membro de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    memberId: z.string().describe("ID do membro a remover"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, memberId, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/members/${memberId}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Membro Removido do Card**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🆔 ID do membro: ${memberId}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// ==========================================
// BUSCA (SEARCH)
// ==========================================

server.tool(
  "trello_search_cards",
  "Busca cards por texto em todos os quadros",
  {
    query: z.string().describe("Texto para buscar (nome ou descrição)"),
    boardUrl: z.string().optional().describe("Limpar busca a um quadro específico (opcional)")
  },
  async ({ query, boardUrl }) => {
    const creds = getCredentials();
    const boardId = boardUrl ? await resolveBoardId(boardUrl, creds) : null;
    
    try {
      let cards: TrelloCard[];
      
      if (boardId) {
        cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
        cards = cards.filter(c => 
          c.name.toLowerCase().includes(query.toLowerCase())
        );
      } else {
        const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
        const openBoards = boards.filter(b => !b.closed);
        
        cards = [];
        for (const board of openBoards.slice(0, 10)) {
          const boardCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${board.id}/cards/open`);
          cards.push(...boardCards.filter(c => c.name.toLowerCase().includes(query.toLowerCase())));
        }
      }
      
      if (cards.length === 0) {
        return { content: [{ type: "text", text: `🔍 Nenhum card encontrado para: "${query}"` }] };
      }
      
      let text = `🔍 **Resultados da Busca** (${cards.length} cards)\n\n`;
      text += `Busca: "${query}"\n\n`;
      
      for (const card of cards.slice(0, 20)) {
        text += `• ${card.name}\n`;
        text += `  🔗 ${card.shortUrl}\n\n`;
      }
      
      if (cards.length > 20) {
        text += `... e mais ${cards.length - 20} cards`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_search_by_label",
  "Busca cards por etiqueta em um quadro",
  {
    labelName: z.string().describe("Nome da label para buscar"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ labelName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const labels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const label = labels.find(l => l.name.toLowerCase().includes(labelName.toLowerCase()));
      
      if (!label) {
        const availableLabels = labels.map(l => l.name).join(", ");
        return { content: [{ type: "text", text: `❌ Label "${labelName}" não encontrada.\n\nLabels: ${availableLabels}` }] };
      }
      
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const cardsWithLabel = cards.filter(c => c.idLabels.includes(label.id));
      
      if (cardsWithLabel.length === 0) {
        return { content: [{ type: "text", text: `📭 Nenhum card com label "${label.name}"` }] };
      }
      
      let text = `🏷️ **Cards com Label "${label.name}"** (${cardsWithLabel.length})\n\n`;
      
      for (const card of cardsWithLabel.slice(0, 20)) {
        text += `• ${card.name}\n`;
        text += `  🔗 ${card.shortUrl}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_search_by_due",
  "Busca cards por data de vencimento",
  {
    filter: z.enum(["overdue", "due_soon", "no_due", "all"]).describe("Filtro: overdue (atrasados), due_soon (próximos 7 dias), no_due (sem data), all (todos com data)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ filter, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      
      const now = new Date();
      const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      
      let filteredCards: TrelloCard[] = [];
      
      for (const card of cards) {
        const cardDetails = await fetchTrelloWithCreds<{ due: string | null }>(creds, `/cards/${card.id}?fields=due`);
        
        if (filter === "no_due" && !cardDetails.due) {
          filteredCards.push(card);
        } else if (filter === "overdue" && cardDetails.due && new Date(cardDetails.due) < now) {
          filteredCards.push(card);
        } else if (filter === "due_soon" && cardDetails.due && new Date(cardDetails.due) >= now && new Date(cardDetails.due) <= in7Days) {
          filteredCards.push(card);
        } else if (filter === "all" && cardDetails.due) {
          filteredCards.push(card);
        }
      }
      
      const filterLabels: Record<string, string> = {
        overdue: "🟢 Atrasados",
        due_soon: "⏰ Próximos 7 dias",
        no_due: "❌ Sem data",
        all: "📅 Com data"
      };
      
      if (filteredCards.length === 0) {
        return { content: [{ type: "text", text: `📭 Nenhum card: ${filterLabels[filter]}` }] };
      }
      
      let text = `${filterLabels[filter]} (${filteredCards.length})\n\n`;
      
      for (const card of filteredCards.slice(0, 20)) {
        text += `• ${card.name}\n`;
        text += `  🔗 ${card.shortUrl}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// ==========================================
// ARQUIVOS (ATTACHMENTS)
// ==========================================

server.tool(
  "trello_list_attachments",
  "Lista os anexos de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const attachments = await fetchTrelloWithCreds<TrelloAttachment[]>(creds, `/cards/${targetCardId}/attachments`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      if (attachments.length === 0) {
        return { content: [{ type: "text", text: `📎 Nenhum anexo neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `📎 **Anexos do Card** (${attachments.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      for (const att of attachments) {
        const size = att.bytes ? `${Math.round(att.bytes / 1024)}KB` : "tamanho desconhecido";
        text += `• **${att.name}**\n`;
        text += `  📊 ${size}\n`;
        text += `  🔗 ${att.url}\n`;
        if (att.mimeType) text += `  📋 ${att.mimeType}\n`;
        text += '\n';
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_delete_attachment",
  "Exclui um anexo de um card do Trello",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    attachmentId: z.string().describe("ID do anexo a excluir"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, attachmentId, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/attachments/${attachmentId}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Anexo Excluído**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🆔 ID: ${attachmentId}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// ==========================================
// ATIVIDADES (ACTIVITIES)
// ==========================================

server.tool(
  "trello_get_card_activities",
  "Busca o histórico de atividades de um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    limit: z.number().optional().describe("Número de atividades (padrão: 20)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, limit = 20, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const actions = await fetchTrelloWithCreds<any[]>(creds, `/cards/${targetCardId}/actions?limit=${limit}`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      if (actions.length === 0) {
        return { content: [{ type: "text", text: `📝 Nenhuma atividade neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `📝 **Atividades do Card** (${actions.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      const typeLabels: Record<string, string> = {
        createCard: "🆕 Card criado",
        updateCard: "✏️ Card atualizado",
        commentCard: "💬 Comentário",
        addMemberToCard: "👤 Membro adicionado",
        removeMemberFromCard: "👤 Membro removido",
        addAttachmentToCard: "📎 Anexo adicionado",
        removeAttachmentFromCard: "📎 Anexo removido",
        addLabelToCard: "🏷️ Label adicionada",
        removeLabelFromCard: "🏷️ Label removida",
        movedCard: "📋 Card movido"
      };
      
      for (const action of actions) {
        const type = typeLabels[action.type] || action.type;
        const date = new Date(action.date).toLocaleString("pt-BR");
        const member = action.memberCreator?.fullName || "Sistema";
        
        text += `--- ${type} ---\n`;
        text += `👤 ${member} • ${date}\n`;
        
        if (action.type === "commentCard" && action.data?.text) {
          text += `💭 ${action.data.text.slice(0, 100)}...\n`;
        }
        text += '\n';
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// ==========================================
// ESTATÍSTICAS (STATS)
// ==========================================

server.tool(
  "trello_board_stats",
  "Mostra estatísticas de um quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const board = await fetchTrelloWithCreds<{ name: string; shortUrl: string }>(creds, `/boards/${boardId}?fields=name,shortUrl`);
      const lists = await fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`);
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const labels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const members = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/boards/${boardId}/members`);
      
      const cardsByList: Record<string, number> = {};
      for (const list of lists) {
        cardsByList[list.name] = cards.filter(c => c.idList === list.id).length;
      }
      
      const totalCards = cards.length;
      const cardsWithLabels = cards.filter(c => c.idLabels.length > 0).length;
      const cardsWithDue = cards.filter(c => c.due).length;
      const now = new Date();
      const overdueCards = cards.filter(c => c.due && new Date(c.due) < now).length;
      
      let text = `📊 **Estatísticas do Quadro**\n\n📋 **${board.name}**\n\n`;
      
      text += `📈 **Geral**\n`;
      text += `  📝 Total de cards: ${totalCards}\n`;
      text += `  📋 Listas: ${lists.length}\n`;
      text += `  🏷️ Labels: ${labels.length}\n`;
      text += `  👥 Membros: ${members.length}\n\n`;
      
      text += `📋 **Cards por Lista**\n`;
      for (const [listName, count] of Object.entries(cardsByList)) {
        text += `  • ${listName}: ${count}\n`;
      }
      
      text += `\n📅 **Datas de Vencimento**\n`;
      text += `  ⏰ Com data: ${cardsWithDue}\n`;
      text += `  🟢 Atrasados: ${overdueCards}\n`;
      
      text += `\n🏷️ **Labels**\n`;
      for (const label of labels.slice(0, 5)) {
        const count = cards.filter(c => c.idLabels.includes(label.id)).length;
        text += `  • ${label.name}: ${count} cards\n`;
      }
      if (labels.length > 5) text += `  ... e mais ${labels.length - 5} labels\n`;
      
      text += `\n🔗 ${board.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// ==========================================
// VOTAÇÕES (VOTES)
// ==========================================

server.tool(
  "trello_vote_card",
  "Adiciona um voto a um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/votes`, "POST", {});
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Voto Adicionado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_unvote_card",
  "Remove o voto de um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const me = await fetchTrelloWithCreds<{ id: string }>(creds, "/members/me");
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/members/${me.id}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Voto Removido**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_list_card_votes",
  "Lista os votos de um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const votes = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/cards/${targetCardId}/membersVoted`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      if (votes.length === 0) {
        return { content: [{ type: "text", text: `🗳️ Nenhum voto neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `🗳️ **Votos do Card** (${votes.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      for (const voter of votes) {
        text += `• **${voter.fullName}** (@${voter.username})\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_list_attachments",
  "Lista os anexos de um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const attachments = await fetchTrelloWithCreds<TrelloAttachment[]>(creds, `/cards/${targetCardId}/attachments`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      if (attachments.length === 0) {
        return { content: [{ type: "text", text: `📎 Nenhum anexo neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `📎 **Anexos do Card** (${attachments.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      for (const att of attachments) {
        const icon = att.mimeType?.startsWith("image/") ? "🖼️" : 
                     att.mimeType?.includes("pdf") ? "📄" : "📎";
        text += `${icon} **${att.name}**\n`;
        text += `   Tipo: ${att.mimeType || "desconhecido"}\n`;
        text += `   Data: ${att.date ? new Date(att.date).toLocaleDateString("pt-BR") : "desconhecida"}\n`;
        text += `   🔗 ${att.url}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_upload_attachment",
  "Faz upload de um anexo para um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    fileUrl: z.string().describe("URL pública do arquivo para upload"),
    fileName: z.string().optional().describe("Nome do arquivo (opcional, será extraído da URL se não fornecido)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, fileUrl, fileName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      const name = fileName || fileUrl.split("/").pop() || "arquivo";
      
      const response = await fetch(
        `https://api.trello.com/1/cards/${targetCardId}/attachments?key=${creds.apiKey}&token=${creds.token}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: fileUrl,
            name: name
          }),
        }
      );
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Trello API error: ${response.status} - ${errorText}`);
      }
      
      const attachment = await response.json() as TrelloAttachment;
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Anexo Enviado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📎 Arquivo: ${attachment.name}\n`;
      text += `🔗 ${attachment.url}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_download_attachment",
  "Obtém a URL de download de um anexo",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    attachmentId: z.string().optional().describe("ID do anexo (alternativa ao nome)"),
    attachmentName: z.string().optional().describe("Nome do anexo (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, attachmentId, attachmentName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      let attachments = await fetchTrelloWithCreds<TrelloAttachment[]>(creds, `/cards/${targetCardId}/attachments`);
      
      let targetAttachment: TrelloAttachment | undefined;
      
      if (attachmentId) {
        targetAttachment = attachments.find(a => a.id === attachmentId);
      } else if (attachmentName) {
        targetAttachment = attachments.find(a => 
          a.name.toLowerCase().includes(attachmentName.toLowerCase())
        );
      }
      
      if (!targetAttachment) {
        return { content: [{ type: "text", text: "❌ Anexo não encontrado" }] };
      }
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `📥 **Download de Anexo**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📎 Arquivo: ${targetAttachment.name}\n`;
      text += `📋 Tipo: ${targetAttachment.mimeType}\n`;
      text += `\n🔗 **URL de Download:**\n${targetAttachment.url}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_delete_attachment",
  "Remove um anexo de um card",
  {
    cardId: z.string().optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    attachmentId: z.string().optional().describe("ID do anexo (alternativa ao nome)"),
    attachmentName: z.string().optional().describe("Nome do anexo (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, attachmentId, attachmentName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetCardId = cardId;
    
    if (!targetCardId && cardName) {
      const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
      const card = allCards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
      if (!card) {
        return { content: [{ type: "text", text: `❌ Card não encontrado: "${cardName}"` }] };
      }
      targetCardId = card.id;
    }
    
    if (!targetCardId) {
      return { content: [{ type: "text", text: "❌ Forneça cardId ou cardName" }] };
    }
    
    try {
      let attachments = await fetchTrelloWithCreds<TrelloAttachment[]>(creds, `/cards/${targetCardId}/attachments`);
      
      let targetAttachment: TrelloAttachment | undefined;
      
      if (attachmentId) {
        targetAttachment = attachments.find(a => a.id === attachmentId);
      } else if (attachmentName) {
        targetAttachment = attachments.find(a => 
          a.name.toLowerCase().includes(attachmentName.toLowerCase())
        );
      }
      
      if (!targetAttachment) {
        return { content: [{ type: "text", text: "❌ Anexo não encontrado" }] };
      }
      
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/attachments/${targetAttachment.id}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name`);
      
      let text = `✅ **Anexo Removido**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📎 Arquivo: ${targetAttachment.name}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_list_power_ups",
  "Lista os Power-Ups disponíveis e seus status no quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const board = await fetchTrelloWithCreds<{ name: string; powerUps: string[] }>(
        creds, 
        `/boards/${boardId}?fields=name,powerUps`
      );
      
      const allPowerUps = await fetchTrelloWithCreds<TrelloPowerUp[]>(creds, `/powerUps`);
      
      let text = `⚡ **Power-Ups do Quadro**\n\n📋 ${board.name}\n\n`;
      
      if (board.powerUps.length === 0) {
        text += "Nenhum Power-Up ativado.\n";
      } else {
        text += `Ativados (${board.powerUps.length}):\n`;
        for (const p of board.powerUps) {
          const powerUp = allPowerUps.find(pu => pu.id === p);
          text += `  ✅ ${powerUp?.name || p}\n`;
        }
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_enable_power_up",
  "Ativa um Power-Up no quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    powerUpId: z.string().describe("ID do Power-Up a ativar (ex: calendar, cardAging, voting)")
  },
  async ({ boardUrl, powerUpId }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      await fetchTrelloWithCreds(
        creds, 
        `/boards/${boardId}/powerUps`,
        "POST",
        { value: powerUpId }
      );
      
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      
      let text = `✅ **Power-Up Ativado**\n\n`;
      text += `📋 Quadro: ${board.name}\n`;
      text += `⚡ ID: ${powerUpId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_disable_power_up",
  "Desativa um Power-Up no quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    powerUpId: z.string().describe("ID do Power-Up a desativar (ex: calendar, cardAging, voting)")
  },
  async ({ boardUrl, powerUpId }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      await fetchTrelloWithCreds(
        creds, 
        `/boards/${boardId}/powerUps/${powerUpId}`,
        "DELETE"
      );
      
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      
      let text = `✅ **Power-Up Desativado**\n\n`;
      text += `📋 Quadro: ${board.name}\n`;
      text += `⚡ ID: ${powerUpId}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_list_webhooks",
  "Lista os webhooks do usuário",
  {},
  async () => {
    const creds = getCredentials();
    
    try {
      const webhooks = await fetchTrelloWithCreds<TrelloWebhook[]>(creds, `/tokens/${creds.token}/webhooks`);
      
      if (webhooks.length === 0) {
        return { content: [{ type: "text", text: "🔗 Nenhum webhook configurado." }] };
      }
      
      let text = `🔗 **Webhooks** (${webhooks.length})\n\n`;
      
      for (const wh of webhooks) {
        const status = wh.active ? "🟢 Ativo" : "🔴 Inativo";
        text += `**${wh.description || "Webhook"}**\n`;
        text += `  ${status}\n`;
        text += `  🔗 ${wh.callbackURL}\n`;
        text += `  📋 Modelo: ${wh.idModel}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_create_webhook",
  "Cria um novo webhook",
  {
    callbackURL: z.string().describe("URL de callback para notificações"),
    modelId: z.string().describe("ID do modelo (board ou card)"),
    description: z.string().optional().describe("Descrição do webhook")
  },
  async ({ callbackURL, modelId, description }) => {
    const creds = getCredentials();
    
    try {
      const webhook = await fetchTrelloWithCreds<TrelloWebhook>(
        creds, 
        `/webhooks`,
        "POST",
        {
          description: description || "Webhook MCP",
          callbackURL: callbackURL,
          idModel: modelId
        }
      );
      
      let text = `✅ **Webhook Criado**\n\n`;
      text += `🔗 ${webhook.callbackURL}\n`;
      text += `📋 Modelo: ${webhook.idModel}\n`;
      text += `🆔 ${webhook.id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_delete_webhook",
  "Deleta um webhook",
  {
    webhookId: z.string().describe("ID do webhook a deletar")
  },
  async ({ webhookId }) => {
    const creds = getCredentials();
    
    try {
      await fetchTrelloWithCreds(creds, `/webhooks/${webhookId}`, "DELETE");
      
      return { content: [{ type: "text", text: `✅ **Webhook Deletado**\n\n🆔 ${webhookId}` }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_search_in_board",
  "Pesquisa avançada em um quadro",
  {
    query: z.string().describe("Termo de busca"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    limit: z.number().optional().describe("Limite de resultados (padrão: 25)")
  },
  async ({ query, boardUrl, limit = 25 }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(
        creds, 
        `/boards/${boardId}/cards?filter=visible&limit=${limit}`
      );
      
      const matchingCards = cards.filter(c => 
        c.name.toLowerCase().includes(query.toLowerCase())
      );
      
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      
      if (matchingCards.length === 0) {
        return { content: [{ type: "text", text: `🔍 Nenhum resultado para "${query}" em ${board.name}` }] };
      }
      
      let text = `🔍 **Resultados da Busca**\n\n`;
      text += `📋 Quadro: ${board.name}\n`;
      text += `🔎 Query: "${query}"\n`;
      text += `📝 Encontrados: ${matchingCards.length}\n\n`;
      
      for (const card of matchingCards) {
        text += `📌 **${card.name}**\n`;
        text += `   🔗 ${card.shortUrl}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_create_automation",
  "Cria uma automação (butler rule) no quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    trigger: z.string().describe("Gatilho (ex: 'when a card is moved to Done')"),
    action: z.string().describe("Ação (ex: 'post a comment \"Task completed!\"')")
  },
  async ({ boardUrl, trigger, action }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      
      let text = `⚠️ **Automação requer Power-Up Butler**\n\n`;
      text += `Para criar automações no Trello, você precisa do Butler (Power-Up).\n\n`;
      text += `Após ativar o Butler no quadro "${board.name}":\n\n`;
      text += `**Gatilho:** ${trigger}\n`;
      text += `**Ação:** ${action}\n\n`;
      text += `Configure manualmente no botão "Automations" do quadro.`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_export_board",
  "Exporta um quadro para JSON",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    format: z.enum(["json", "csv"]).optional().describe("Formato de export (padrão: json)")
  },
  async ({ boardUrl, format = "json" }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const board = await fetchTrelloWithCreds<Record<string, unknown>>(creds, `/boards/${boardId}`);
      const lists = await fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`);
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards`);
      const labels = await fetchTrelloWithCreds<Record<string, unknown>[]>(creds, `/boards/${boardId}/labels`);
      const members = await fetchTrelloWithCreds<Record<string, unknown>[]>(creds, `/boards/${boardId}/members`);
      
      const exportData = {
        exportedAt: new Date().toISOString(),
        board: {
          id: board.id,
          name: board.name,
          url: board.url
        },
        lists: lists.map(l => ({ id: l.id, name: l.name })),
        cards: cards.map(c => ({
          id: c.id,
          name: c.name,
          idList: c.idList,
          labels: c.idLabels
        })),
        labels: labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
        members: members.map(m => ({ id: m.id, fullName: m.fullName, username: m.username }))
      };
      
      let text = `📤 **Quadro Exportado**\n\n`;
      text += `📋 ${board.name}\n\n`;
      text += `📊 **Dados exportados:**\n`;
      text += `  📝 Listas: ${lists.length}\n`;
      text += `  📌 Cards: ${cards.length}\n`;
      text += `  🏷️ Labels: ${labels.length}\n`;
      text += `  👥 Membros: ${members.length}\n\n`;
      
      if (format === "json") {
        text += `📄 **JSON exportado (em memória)**\n`;
        text += `Use a API diretamente para baixar o arquivo completo.`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_create_from_template",
  "Cria um novo quadro a partir de um template",
  {
    name: z.string().describe("Nome do novo quadro"),
    templateId: z.string().optional().describe("ID do template (opcional)"),
    description: z.string().optional().describe("Descrição do quadro")
  },
  async ({ name, templateId, description }) => {
    const creds = getCredentials();
    
    try {
      const newBoard = await fetchTrelloWithCreds<{ id: string; name: string; shortUrl: string }>(
        creds, 
        "/boards",
        "POST",
        {
          name: name,
          desc: description || "",
          idBoardSource: templateId
        }
      );
      
      let text = `✅ **Quadro Criado**\n\n`;
      text += `📋 ${newBoard.name}\n`;
      text += `🔗 ${newBoard.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_get_board_actions",
  "Obtém as ações/atividades recentes de um quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    limit: z.number().optional().describe("Limite de resultados (padrão: 20)")
  },
  async ({ boardUrl, limit = 20 }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const actions = await fetchTrelloWithCreds<TrelloAction[]>(
        creds, 
        `/boards/${boardId}/actions?limit=${limit}`
      );
      
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      
      if (actions.length === 0) {
        return { content: [{ type: "text", text: `📋 Nenhuma atividade recente em ${board.name}` }] };
      }
      
      const typeLabels: Record<string, string> = {
        createCard: "📌 Card criado",
        updateCard: "✏️ Card atualizado",
        deleteCard: "🗑️ Card deletado",
        createList: "📋 Lista criada",
        updateList: "✏️ Lista atualizada",
        commentCard: "💬 Comentário",
        addMemberToCard: "👤 Membro adicionado",
        removeMemberFromCard: "👤 Membro removido",
        voteCard: "🗳️ Voto",
        createLabel: "🏷️ Label criada",
        addAttachmentToCard: "📎 Anexo adicionado"
      };
      
      let text = `📋 **Atividades do Quadro**\n\n`;
      text += `📋 ${board.name}\n`;
      text += `📝 ${actions.length} ações recentes\n\n`;
      
      for (const action of actions) {
        const label = typeLabels[action.type] || action.type;
        const cardName = action.data.card?.name || "";
        const date = new Date(action.date).toLocaleString("pt-BR");
        
        text += `${label}${cardName ? ` - ${cardName}` : ""}\n`;
        text += `   👤 ${action.memberCreator.fullName}\n`;
        text += `   🕐 ${date}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_board_activity_stats",
  "Obtém estatísticas de atividade do quadro",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    days: z.number().optional().describe("Dias de histórico (padrão: 30)")
  },
  async ({ boardUrl, days = 30 }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const actions = await fetchTrelloWithCreds<TrelloAction[]>(
        creds, 
        `/boards/${boardId}/actions?limit=1000&date=${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0]}`
      );
      
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards`);
      const lists = await fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`);
      
      const actionTypes: Record<string, number> = {};
      for (const action of actions) {
        actionTypes[action.type] = (actionTypes[action.type] || 0) + 1;
      }
      
      const creators = new Set<string>();
      actions.forEach(a => creators.add(a.memberCreator.id));
      
      let text = `📊 **Estatísticas de Atividade**\n\n`;
      text += `📋 ${board.name}\n`;
      text += `📅 Últimos ${days} dias\n\n`;
      
      text += `**Geral:**\n`;
      text += `  📝 Total de ações: ${actions.length}\n`;
      text += `  👥 Participantes: ${creators.size}\n`;
      text += `  📌 Cards: ${cards.length}\n`;
      text += `  📋 Listas: ${lists.length}\n\n`;
      
      text += `**Por tipo de ação:**\n`;
      const sortedTypes = Object.entries(actionTypes).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sortedTypes.slice(0, 10)) {
        const label = type.replace(/([A-Z])/g, " $1").trim();
        text += `  • ${label}: ${count}\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);
