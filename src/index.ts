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
  dateLastActivity: string;
  dateCreated: string;
  labels: {
    id: string;
    name: string;
    color: string;
  }[];
}

interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  fileName?: string;
  mimeType?: string;
  bytes?: number;
  date: string;
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
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `https://api.trello.com/1${endpoint}${separator}key=${creds.apiKey}&token=${creds.token}`;
  
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
    return currentBoardId || cfg.boardId;
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
  "trello_tasks",
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
    due: z.string().optional().describe("Data de vencimento (ISO 8601, 'today', 'tomorrow', 'next week', ou '' para remover"),
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
      if (due === "") {
        // Remover data de vencimento
        updateData.due = "";
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
      labelChanges.push(`Data de vencimento: ${due}`);
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
    
    if (Object.keys(updateData).length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: `❌ Nenhum campo para atualizar. Forneça pelo menos um campo (name, desc, listName, labelIds, addLabelIds, addLabelNames, removeLabelIds, removeLabelNames, due, dueComplete).` 
        }],
      };
    }
    
    try {
      const card = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`, "PUT", updateData);
      
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
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=all&actions=all&board=true&lists=all&labels=all`);
      
      let output = `📌 **${cardDetails.name}**\n\n`;
      output += `🆔 ID: ${cardDetails.id}\n`;
      if (cardDetails.desc) output += `📄 Descrição: ${cardDetails.desc.substring(0, 100)}...\n`;
      output += `🔗 ${cardDetails.shortUrl}\n`;
      
      if (cardDetails.labels && cardDetails.labels.length > 0) {
        output += `\n🏷️ Labels: ${cardDetails.labels.map(l => l.name).join(', ')}\n`;
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
