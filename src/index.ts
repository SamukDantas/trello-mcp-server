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
  method: "GET" | "POST" | "PUT" = "GET",
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
  method: "GET" | "POST" | "PUT" = "GET",
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
  "trello_list_all",
  "Lista todas as tarefas de todas as listas do quadro",
  {},
  async () => {
    const cfg = loadConfig();
    const [cards, lists] = await Promise.all([
      getAllCards(cfg),
      getLists(cfg),
    ]);
    
    const pontoFocalCards = cards.filter(c => c.idLabels.includes(cfg.labels.pontoFocal));
    
    if (!pontoFocalCards.length) {
      return {
        content: [{ type: "text", text: "✅ Nenhuma tarefa encontrada!" }],
      };
    }
    
    const listNames: Record<string, string> = {
      [cfg.lists.backlog]: "📋 Backlog",
      [cfg.lists.doing]: "🔄 Doing",
      [cfg.lists.testing]: "🧪 Testing",
      [cfg.lists.done]: "✅ Done",
    };
    
    const grouped: Record<string, TrelloCard[]> = {};
    pontoFocalCards.forEach(card => {
      if (!grouped[card.idList]) grouped[card.idList] = [];
      grouped[card.idList].push(card);
    });
    
    let text = `📊 **Quadro Trello** (${pontoFocalCards.length} tarefas)\n\n`;
    
    for (const [listId, listCards] of Object.entries(grouped)) {
      const listName = listNames[listId] || `📁 ${lists.find(l => l.id === listId)?.name || "Desconhecido"}`;
      text += `${listName} (${listCards.length})\n`;
      text += listCards.map(c => `  • ${c.name}`).join("\n");
      text += "\n\n";
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_list_by_list",
  "Lista todas as tarefas de uma lista específica (sem filtro de label)",
  { 
    listName: z.string().describe("Nome da lista: backlog, doing, testing, done"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional, usa o ativo se não informado)")
  },
  async ({ listName, boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
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
      if (list) {
        listId = list.id;
      }
    }
    
    if (!listId) {
      return {
        content: [{ type: "text", text: `❌ Lista "${listName}" não encontrada. Use: backlog, doing, testing ou done` }],
      };
    }
    
    const [cards, lists] = await Promise.all([
      fetchTrelloWithCreds<TrelloCard[]>(creds, `/lists/${listId}/cards`),
      getBoardLists(creds, boardId),
    ]);
    
    const list = lists.find(l => l.id === listId);
    const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
    const board = boards.find(b => b.id === boardId);
    
    const listEmoji: Record<string, string> = {
      "backlog": "📋",
      "doing": "🔄",
      "testing": "🧪",
      "done": "✅",
    };
    
    if (!cards.length) {
      return {
        content: [{ type: "text", text: `✅ Lista "${list?.name || listName}" está vazia!` }],
      };
    }
    
    const emoji = listEmoji[listName.toLowerCase()] || "📁";
    let text = `📊 **${board?.name || "Quadro"}**\n\n`;
    text += `${emoji} **${list?.name || listName}** (${cards.length} tarefas)\n\n`;
    
    for (const card of cards) {
      text += `• ${card.name}\n`;
      text += `  🔗 ${card.shortUrl}\n`;
    }
    
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trello_get_card_details",
  "Busca detalhes de uma tarefa: descrição, checklists, comentários, anexos, membros e labels",
  { 
    name: z.string().describe("Nome ou parte do nome da tarefa"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional, usa o ativo se não informado)")
  },
  async ({ name, boardUrl }) => {
    const cfg = loadConfig();
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const allCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
    const searchName = name.toLowerCase().trim();
    const card = allCards.find(c => 
      c.name.toLowerCase().includes(searchName) || 
      searchName.includes(c.name.toLowerCase())
    ) || null;
    
    if (!card) {
      return {
        content: [{ type: "text", text: `❌ Tarefa não encontrada: "${name}"` }],
      };
    }
    
    const [details, checklists, comments, attachments, boardLabels, lists, boards] = await Promise.all([
      fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${card.id}`),
      fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`),
      fetchTrelloWithCreds<TrelloComment[]>(creds, `/cards/${card.id}/actions?filter=commentCard`),
      fetchTrelloWithCreds<TrelloAttachment[]>(creds, `/cards/${card.id}/attachments`),
      fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`),
      getBoardLists(creds, boardId),
      fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards"),
    ]);
    
    const members = details.idMembers.length > 0 
      ? await getMembers(cfg, details.idMembers) 
      : [];
    
    const board = boards.find(b => b.id === boardId);
    const list = lists.find(l => l.id === details.idList);
    
    const listEmoji: Record<string, string> = {
      "backlog": "📋",
      "doing": "🔄", 
      "testing": "🧪",
      "done": "✅",
    };
    
    let listDisplayName = list?.name || "Desconhecido";
    for (const [key, emoji] of Object.entries(listEmoji)) {
      if (list?.name.toLowerCase().includes(key) || 
          (key === "doing" && list?.name.toLowerCase().includes("fazendo")) ||
          (key === "done" && (list?.name.toLowerCase().includes("concluído") || list?.name.toLowerCase().includes("concluido")))) {
        listDisplayName = `${emoji} ${list.name}`;
        break;
      }
    }
    
    let text = `📝 **${details.name}**\n`;
    text += `🔗 ${details.shortUrl}\n`;
    text += `📊 Quadro: ${board?.name || "Desconhecido"}\n`;
    text += `📍 ${listDisplayName}\n`;
    
    if (details.due) {
      const dueDate = new Date(details.due);
      const now = new Date();
      const isOverdue = dueDate < now;
      text += `📅 Vencimento: ${dueDate.toLocaleDateString("pt-BR")} ${isOverdue ? "⚠️ ATRASADA" : ""}\n`;
    }
    
    if (details.dateCreated) {
      text += `🕐 Criada em: ${new Date(parseInt(details.dateCreated)).toLocaleString("pt-BR")}\n`;
    }
    
    if (details.dateLastActivity) {
      text += `🔄 Última atividade: ${new Date(details.dateLastActivity).toLocaleString("pt-BR")}\n`;
    }
    
    text += `\n`;
    
    if (details.labels && details.labels.length > 0) {
      text += `🏷️ **Labels:**\n`;
      for (const label of details.labels) {
        const emoji: Record<string, string> = {
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
        text += `  ${emoji[label.color] || "🏷️"} ${label.name || label.color}\n`;
      }
      text += `\n`;
    }
    
    if (members.length > 0) {
      text += `👥 **Membros (${members.length}):**\n`;
      for (const member of members) {
        text += `  • ${member.fullName} (@${member.username})\n`;
      }
      text += `\n`;
    }
    
    if (details.desc && details.desc.trim()) {
      text += `📄 **Descrição:**\n${details.desc}\n\n`;
    }
    
    if (attachments.length > 0) {
      text += `📎 **Anexos (${attachments.length}):**\n`;
      for (const att of attachments.slice(0, 10)) {
        const size = att.bytes ? ` (${(att.bytes / 1024).toFixed(1)} KB)` : "";
        text += `  • ${att.name}${size}\n`;
        text += `    🔗 ${att.url}\n`;
      }
      if (attachments.length > 10) {
        text += `  ... e mais ${attachments.length - 10} anexos\n`;
      }
      text += `\n`;
    }
    
    if (checklists.length > 0) {
      let totalItems = 0;
      let completedItems = 0;
      for (const checklist of checklists) {
        totalItems += checklist.checkItems.length;
        completedItems += checklist.checkItems.filter(i => i.state === "complete").length;
      }
      
      text += `✅ **Checklists** (${completedItems}/${totalItems}):\n`;
      for (const checklist of checklists) {
        const completed = checklist.checkItems.filter(i => i.state === "complete").length;
        const total = checklist.checkItems.length;
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
        text += `\n  📋 ${checklist.name} (${completed}/${total}) - ${progress}%\n`;
        for (const item of checklist.checkItems) {
          const status = item.state === "complete" ? "☑️" : "⬜";
          text += `    ${status} ${item.name}\n`;
        }
      }
      text += `\n`;
    }
    
    if (comments.length > 0) {
      text += `💬 **Comentários (${comments.length}):**\n`;
      const recentComments = comments.slice(0, 5);
      for (const comment of recentComments) {
        const date = new Date(comment.date).toLocaleString("pt-BR");
        text += `\n  👤 ${comment.memberCreator.fullName} - ${date}\n`;
        text += `  "${comment.data.text.slice(0, 300)}${comment.data.text.length > 300 ? "..." : ""}"\n`;
      }
      if (comments.length > 5) {
        text += `\n  ... e mais ${comments.length - 5} comentários\n`;
      }
    }
    
    return { content: [{ type: "text", text }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
