import { configureSystemCertificateTrust, requestTrello } from "./network.js";
import { registerWorkflowTools } from "./workflow-tools.js";
import { selectList } from "./selection.js";
import { registerPlatformTools } from "./platform-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

configureSystemCertificateTrust();

interface TrelloConfig {
  apiKey: string;
  token: string;
  boardId?: string;
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
  dueComplete?: boolean;
  desc?: string;
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

let currentBoardId: string | null = null;
// shortLink -> ID de 24 caracteres. O vínculo é imutável no Trello, então pode ser reaproveitado.
const boardIdByShortLink = new Map<string, string>();

interface TrelloCredentials {
  apiKey: string;
  token: string;
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;
// IDs e shortLinks do Trello são alfanuméricos. Rejeitar o resto impede que um ID
// malformado ("../boards/x", "abc?closed=true") aponte para outro recurso ou injete parâmetros.
const trelloId = z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/, "ID do Trello inválido: use apenas letras e números");
const SAFE_PATH = /^(\/[A-Za-z0-9_-]+)+$/;
const credential = z.string().trim().regex(/^[^\s"\\]+$/, "valor inválido");
const configSchema = z.object({
  apiKey: credential,
  token: credential,
  boardId: trelloId.optional(),
});

function loadConfig(): TrelloConfig {
  const configPath = path.join(os.homedir(), ".config", "opencode", "trello-config.json");

  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  let fromFile: unknown = {};
  if (fs.existsSync(configPath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      throw new Error(`Configuração inválida: ${configPath} não contém JSON válido`);
    }
  } else if (!apiKey || !token) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // Variáveis de ambiente têm precedência: assim as credenciais não precisam ficar em disco.
  const parsed = configSchema.safeParse({
    ...(fromFile as object),
    ...(apiKey ? { apiKey } : {}),
    ...(token ? { token } : {}),
  });
  if (!parsed.success) {
    throw new Error(`Configuração inválida: defina TRELLO_API_KEY e TRELLO_TOKEN no ambiente, ou apiKey e token (textos sem espaços) em ${configPath}`);
  }
  return parsed.data;
}

function getCredentials(): TrelloCredentials {
  const cfg = loadConfig();
  return { apiKey: cfg.apiKey, token: cfg.token };
}

async function fetchTrelloWithCreds<T>(
  creds: TrelloCredentials,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: object
): Promise<T> {
  const [pathname] = endpoint.split("?");
  if (!SAFE_PATH.test(pathname)) {
    throw new Error("Identificador inválido na requisição ao Trello: use os IDs retornados pelas listagens");
  }

  // Credenciais vão no cabeçalho, nunca na URL: URLs acabam em logs de proxy e mensagens de erro.
  const res = await requestTrello(`https://api.trello.com/1${endpoint}`, {
    method,
    headers: {
      Authorization: `OAuth oauth_consumer_key="${creds.apiKey}", oauth_token="${creds.token}"`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => ""))
      .split(creds.token).join("***")
      .split(creds.apiKey).join("***")
      .trim()
      .slice(0, 300);
    throw new Error(`Trello API error: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`);
  }

  return res.json();
}

/**
 * Seleciona um item pelo nome sem escolher arbitrariamente: nome exato primeiro,
 * depois trecho do nome somente se identificar um único item.
 */
function pickByName<T extends { id: string; name: string }>(items: T[], name: string, kind: string, exactOnly = false): T {
  const wanted = name.trim().toLowerCase();
  const describe = (matches: T[]) => matches.slice(0, 5).map(item => `"${item.name}" (${item.id})`).join("; ");
  const exact = items.filter(item => item.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Nome de ${kind} ambíguo: "${name}" corresponde a ${exact.length} itens: ${describe(exact)}. Informe o ID`);
  if (exactOnly) throw new Error(`${kind} não encontrado com o nome exato "${name}". Informe o nome completo ou o ID`);
  const partial = wanted ? items.filter(item => item.name.toLowerCase().includes(wanted)) : [];
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Nome de ${kind} ambíguo: "${name}" corresponde a ${partial.length} itens: ${describe(partial)}. Informe o ID`);
  throw new Error(`${kind} não encontrado: "${name}"`);
}

async function resolveBoardId(input: string | undefined, creds: TrelloCredentials): Promise<string> {
  const value = (input ?? currentBoardId ?? loadConfig().boardId ?? "").trim();
  if (!value) {
    throw new Error("Nenhum quadro definido: informe boardUrl, use trello_set_board ou configure boardId");
  }
  if (OBJECT_ID.test(value)) return value;

  const fromUrl = value.match(/trello\.com\/b\/([A-Za-z0-9]+)/)?.[1];
  const shortLink = fromUrl ?? (/^[A-Za-z0-9]{8}$/.test(value) ? value : undefined);
  if (shortLink) {
    const cached = boardIdByShortLink.get(shortLink);
    if (cached) return cached;
    try {
      const board = await fetchTrelloWithCreds<{ id: string }>(creds, `/boards/${shortLink}?fields=id`);
      boardIdByShortLink.set(shortLink, board.id);
      return board.id;
    } catch (error) {
      // Uma palavra de 8 letras também pode ser o nome de um quadro; só a URL é conclusiva.
      if (fromUrl) throw new Error(`Board não encontrado: ${value}`);
    }
  }

  const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
  return pickByName(boards, value, "Quadro").id;
}

async function resolveCardId(
  creds: TrelloCredentials,
  boardId: string,
  cardId: string | undefined,
  cardName: string | undefined,
  exactOnly = false
): Promise<string> {
  if (cardId) return cardId;
  if (!cardName?.trim()) throw new Error("Forneça cardId ou cardName");
  const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`);
  return pickByName(cards, cardName, "Card", exactOnly).id;
}

async function getBoardLists(creds: TrelloCredentials, boardId: string): Promise<TrelloList[]> {
  return fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`);
}

/** Nomes de etiqueta viram IDs por nome exato; inexistente ou repetido é erro, nunca aproximação. */
function labelIdsByName(labels: TrelloBoardLabel[], names: string[]): string[] {
  return names.map(name => pickByName(labels, name, "Label", true).id);
}

interface BoardPrefsInput {
  visibility?: "private" | "team" | "public";
  votingEnabled?: boolean;
  commentsEnabled?: boolean;
  invitationsEnabled?: boolean;
  selfJoinEnabled?: boolean;
}

/**
 * Traduz as preferências da ferramenta para os parâmetros da API do Trello, que são
 * prefs_<nome> na criação e prefs/<nome> na atualização, com valores próprios (ex.: team -> org).
 */
function boardPrefsQuery(prefs: BoardPrefsInput | undefined, separator: "_" | "/"): string {
  if (!prefs) return "";
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined) params.set(`prefs${separator}${key}`, value);
  };
  const toggle = (flag: boolean | undefined, on: string, off: string) => flag === undefined ? undefined : flag ? on : off;
  set("permissionLevel", prefs.visibility && { private: "private", team: "org", public: "public" }[prefs.visibility]);
  set("voting", toggle(prefs.votingEnabled, "members", "disabled"));
  set("comments", toggle(prefs.commentsEnabled, "members", "disabled"));
  set("invitations", toggle(prefs.invitationsEnabled, "members", "admins"));
  set("selfJoin", toggle(prefs.selfJoinEnabled, "true", "false"));
  return params.toString();
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
      text += `  🆔 ${board.id}\n  🔗 ${board.shortUrl}\n\n`;
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
      
      const prefsQuery = boardPrefsQuery(prefs, "_");
      const newBoard = await fetchTrelloWithCreds<TrelloBoard>(creds, `/boards${prefsQuery ? `?${prefsQuery}` : ""}`, "POST", boardData);
      
      let text = `✅ **Quadro Criado**\n\n`;
      text += `📋 **${newBoard.name}**\n`;
      if (description) text += `📄 ${description.slice(0, 100)}...\n`;
      text += `🆔 ${newBoard.id}\n`;
      text += `\n🔗 ${newBoard.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    boardId: trelloId.optional().describe("ID do quadro (alternativa ao nome)"),
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
      const foundBoard = pickByName(boards, boardName, "Quadro");
      targetBoardId = foundBoard.id;
    }
    
    if (!targetBoardId) {
      return {
        isError: true,
        content: [{ type: "text", text: "❌ Forneça boardId ou boardName" }],
      };
    }
    
    const updateData: Record<string, unknown> = {};
    
    if (newName) updateData.name = newName;
    if (newDescription !== undefined) updateData.desc = newDescription;
    if (closed !== undefined) updateData.closed = closed;
    
    const prefsQuery = boardPrefsQuery(prefs, "/");
    
    if (Object.keys(updateData).length === 0 && !prefsQuery) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "❌ Forneça pelo menos um campo para atualizar: newName, newDescription, closed, ou prefs"
        }],
      };
    }
    
    try {
      const updatedBoard = await fetchTrelloWithCreds<TrelloBoard>(creds, `/boards/${targetBoardId}${prefsQuery ? `?${prefsQuery}` : ""}`, "PUT", updateData);
      
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
        isError: true,
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
    boardId: trelloId.optional().describe("ID do quadro (alternativa ao nome)"),
    boardName: z.string().optional().describe("Nome ou parte do nome do quadro (alternativa ao ID)"),
    permanent: z.boolean().optional().describe("Excluir permanentemente em vez de arquivar. Exige confirm: true e, se usar boardName, o nome exato"),
    confirm: z.boolean().optional().describe("Obrigatório (true) para a exclusão permanente, que não pode ser desfeita")
  },
  async ({ boardId, boardName, permanent, confirm }) => {
    if (permanent && confirm !== true) {
      return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Exclusão permanente não executada. Ela não pode ser desfeita: repita com confirm: true, ou omita permanent para apenas arquivar o quadro." }],
      };
    }

    const creds = getCredentials();
    
    let targetBoardId = boardId;
    let boardNameDeleted = boardName || "Quadro";
    
    if (!targetBoardId && boardName) {
      const boards = await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards");
      const foundBoard = pickByName(boards, boardName, "Quadro", permanent === true);
      targetBoardId = foundBoard.id;
      boardNameDeleted = foundBoard.name;
    }
    
    if (!targetBoardId) {
      return {
        isError: true,
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
        isError: true,
        content: [{
          type: "text",
          text: `❌ Erro ao excluir quadro: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

// Atalhos legados registrados em workflow-tools.ts com parâmetros explícitos.

server.tool(
  "trello_create_card",
  "Cria um card completo com lista, labels e descrição personalizáveis",
  {
    name: z.string().describe("Título do card"),
    listId: trelloId.optional().describe("ID da lista escolhida"),
    listName: z.string().trim().min(1).optional().describe("Nome exato da lista; use listId se houver nomes repetidos"),
    labelIds: z.array(trelloId).optional().describe("IDs das labels a adicionar"),
    labelNames: z.array(z.string()).optional().describe("Nomes das labels (alternativa aos IDs)"),
    desc: z.string().optional().describe("Descrição do card (suporta Markdown)"),
    due: z.string().optional().describe("Data de vencimento (ISO format ou relativo como 'tomorrow')"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ name, listId, listName, labelIds, labelNames, desc, due, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const destination = selectList(await getBoardLists(creds, boardId), listId, listName);
    const targetListId = destination.id;

    const finalLabelIds = [...(labelIds ?? [])];
    if (labelNames && labelNames.length > 0) {
      const boardLabels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      for (const id of labelIdsByName(boardLabels, labelNames)) {
        if (!finalLabelIds.includes(id)) finalLabelIds.push(id);
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
      text += `📋 Lista: ${destination.name}\n`;
      if (desc) text += `📄 Descrição completa:\n${desc}\n\n`;
      if (finalLabelIds.length > 0) text += `🏷️ Labels: ${finalLabelIds.length}\n`;
      if (due) text += `📅 Vencimento: ${due}\n`;
      text += `\n🔗 ${card.shortUrl}\n`;
      text += `🆔 ${card.id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    text: z.string().describe("Texto do comentário"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, text, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card a atualizar"),
    cardName: z.string().optional().describe("Nome exato do card (alternativa ao ID)"),
    listId: trelloId.optional().describe("ID da lista escolhida"),
    listName: z.string().trim().min(1).optional().describe("Nome exato da lista; use listId se houver nomes repetidos"),
    name: z.string().optional().describe("Novo título do card"),
    desc: z.string().optional().describe("Nova descrição"),
    labelIds: z.array(trelloId).optional().describe("Array de IDs de labels para SUBSTITUIR todas as labels existentes"),
    labelNames: z.array(z.string()).optional().describe("Array de nomes de labels para SUBSTITUIR todas as labels existentes"),
    addLabelIds: z.array(trelloId).optional().describe("Array de IDs de labels para ADICIONAR às existentes (não remove outras)"),
    addLabelNames: z.array(z.string()).optional().describe("Array de nomes de labels para ADICIONAR às existentes (não remove outras)"),
    removeLabelIds: z.array(trelloId).optional().describe("Array de IDs de labels para REMOVER"),
    removeLabelNames: z.array(z.string()).optional().describe("Array de nomes de labels para REMOVER"),
    due: z.string().optional().describe("Data de vencimento (ISO 8601, 'today', 'tomorrow', 'next week', ou 'remove' para remover"),
    dueComplete: z.boolean().optional().describe("Marcar o card como concluído, mesmo sem vencimento"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, listId, listName, name, desc, labelIds, labelNames, addLabelIds, addLabelNames, removeLabelIds, removeLabelNames, due, dueComplete, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName, true);
    
    // Buscar labels atuais do card (sem limitar campos para garantir que idLabels seja retornado)
    const currentCard = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=idLabels,idBoard`);
    const currentLabelIds = currentCard.idLabels || [];
    
    const updateData: Record<string, unknown> = {};
    const labelChanges: string[] = [];
    
    if (name) updateData.name = name;
    if (desc !== undefined) updateData.desc = desc;
    
    // Etiquetas: a substituição define a base; depois somam-se as adições e retiram-se as remoções.
    // Assim, combinar os modos na mesma chamada não descarta nenhum deles.
    const requestedNames = [...(labelNames ?? []), ...(addLabelNames ?? []), ...(removeLabelNames ?? [])];
    const boardLabels = requestedNames.length > 0
      ? await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`)
      : [];
    const replaceIds = [...(labelIds ?? []), ...labelIdsByName(boardLabels, labelNames ?? [])];
    const addIds = [...(addLabelIds ?? []), ...labelIdsByName(boardLabels, addLabelNames ?? [])];
    const removeIds = [...(removeLabelIds ?? []), ...labelIdsByName(boardLabels, removeLabelNames ?? [])];
    if (replaceIds.length > 0 || addIds.length > 0 || removeIds.length > 0) {
      const base = replaceIds.length > 0 ? replaceIds : currentLabelIds;
      const finalIds = [...new Set([...base, ...addIds])].filter(id => !removeIds.includes(id));
      updateData.idLabels = finalIds.join(",");
      if (replaceIds.length > 0) labelChanges.push(`Labels substituídas: ${replaceIds.length}`);
      if (addIds.length > 0) labelChanges.push(`Labels adicionadas: ${addIds.filter(id => !base.includes(id)).length}`);
      if (removeIds.length > 0) labelChanges.push(`Labels removidas: ${removeIds.filter(id => base.includes(id) || addIds.includes(id)).length}`);
    }

    // Handle due date
    if (due !== undefined) {
      if (due === "remove" || due === "") {
        // A API ignora due: null em JSON; a string vazia é o que de fato remove a data.
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
    
    // Handle dueComplete
    if (dueComplete !== undefined) {
      updateData.dueComplete = dueComplete;
      labelChanges.push(dueComplete ? "Marcado como concluído" : "Marcado como pendente");
    }
    
    if (listId !== undefined || listName !== undefined) {
      updateData.idList = selectList(await getBoardLists(creds, boardId), listId, listName).id;
      updateData.idBoard = boardId;
    }

    if (Object.keys(updateData).length === 0) {
      return {
        isError: true,
        content: [{ 
          type: "text", 
          text: `❌ Nenhum campo para atualizar. Forneça pelo menos um campo (name, desc, listId, listName, labelIds, addLabelIds, addLabelNames, removeLabelIds, removeLabelNames, due, dueComplete). Ex: due: "remove" para remover data`
        }],
      };
    }
    
    try {
      const card = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`, "PUT", updateData);

      let text = `✅ **Card Atualizado**\n\n`;
      text += `🆔 ${targetCardId}\n`;
      if (name) text += `📌 Título: ${name}\n`;
      if (desc !== undefined) text += `📄 Descrição atualizada\n`;
      if (listId || listName) text += `📋 Movido para: ${listName || listId}\n`;
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
        isError: true,
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
  "Busca detalhes de um card do Trello com a descrição completa, sem truncamento, preservando Markdown",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=all&actions=all&board=true&lists=all&labels=all&checklists=all`);
      
      let output = `📌 **${cardDetails.name}**\n\n`;
      output += `🆔 ID: ${cardDetails.id}\n`;
      output += cardDetails.desc
        ? `📄 Descrição completa:\n${cardDetails.desc}\n\n`
        : `📄 Descrição: (vazia)\n`;
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    due: z.string().describe("Data de vencimento: ISO 8601, 'today', 'tomorrow', 'next week', ou data específica"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, due, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
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
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due,shortUrl`);
      
      const formattedDue = new Date(dueDate).toLocaleString("pt-BR");
      
      let text = `✅ **Data de Vencimento Definida**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📅 Vencimento: ${formattedDue}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due,dueComplete,shortUrl`);
      
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const cardDetailsBefore = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due,shortUrl`);
      
      if (!cardDetailsBefore.due) {
        return {
          content: [{ 
            type: "text", 
            text: `ℹ️ Nenhuma data de vencimento para remover.\n\n📌 Card: ${cardDetailsBefore.name}\n🔗 ${cardDetailsBefore.shortUrl}`
          }],
        };
      }
      
      const oldDue = new Date(cardDetailsBefore.due).toLocaleString("pt-BR");
      
      // A API ignora due: null em JSON; a string vazia é o que de fato remove a data.
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}`, "PUT", { due: "" });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Data de Vencimento Removida**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📅 Removida: ${oldDue}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
  "Marca um card como concluído ou pendente, mesmo sem vencimento; não move de lista",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    complete: z.boolean().describe("true = concluída, false = pendente"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, complete, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}`, "PUT", { dueComplete: complete });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,due,dueComplete,shortUrl`);
      
      const status = complete ? "✅ Concluída" : "⏳ Pendente";
      
      let text = `✅ **Conclusão do Card Atualizada**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      if (cardDetails.due) text += `📅 Vencimento: ${new Date(cardDetails.due!).toLocaleString("pt-BR")}\n`;
      text += `📊 Status: ${status}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
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
        isError: true,
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



// ==========================================
// FERRAMENTAS DE EXCLUSÃO
// ==========================================

server.tool(
  "trello_delete_card",
  "Exclui um card específico do Trello",
  {
    cardId: trelloId.optional().describe("ID do card a excluir"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName, true);
    
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
        isError: true,
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
    listId: trelloId.optional().describe("ID da lista; sem listId e listName, opera no quadro todo"),
    listName: z.string().trim().min(1).optional().describe("Nome exato da lista; use listId se houver nomes repetidos"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    confirm: z.boolean().describe("Confirmação obrigatória: true para executar a exclusão")
  },
  async ({ listId, listName, boardUrl, confirm }) => {
    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: "⚠️ Operação cancelada. Use confirm: true para confirmar a exclusão.",
        }],
      };
    }
    
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let cardsToDelete: TrelloCard[] = [];
    let listDisplayName = "todo o quadro";
    
    if (listId !== undefined || listName !== undefined) {
      const destination = selectList(await getBoardLists(creds, boardId), listId, listName);
      cardsToDelete = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/lists/${destination.id}/cards`);
      listDisplayName = destination.name;
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
    listId: trelloId.optional().describe("ID da lista; sem listId e listName, opera no quadro todo"),
    listName: z.string().trim().min(1).optional().describe("Nome exato da lista; use listId se houver nomes repetidos"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    confirm: z.boolean().describe("Confirmação obrigatória: true para executar")
  },
  async ({ listId, listName, boardUrl, confirm }) => {
    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: "⚠️ Operação cancelada. Use confirm: true para confirmar.",
        }],
      };
    }
    
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let cardsToArchive: TrelloCard[] = [];
    let listDisplayName = "todo o quadro";
    
    if (listId !== undefined || listName !== undefined) {
      const destination = selectList(await getBoardLists(creds, boardId), listId, listName);
      cardsToArchive = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/lists/${destination.id}/cards`);
      listDisplayName = destination.name;
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
    listId: trelloId.optional().describe("ID da lista escolhida"),
    listName: z.string().trim().min(1).optional().describe("Nome exato da lista; use listId se houver nomes repetidos"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ listId, listName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const foundList = selectList(await getBoardLists(creds, boardId), listId, listName);

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
      text += `  🆔 ${card.id}\n  🔗 ${card.shortUrl}\n\n`;
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
        isError: true,
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
    listId: trelloId.optional().describe("ID da lista (alternativa ao nome)"),
    listName: z.string().optional().describe("Nome exato da lista (alternativa ao ID)"),
    newName: z.string().optional().describe("Novo nome para a lista"),
    newPos: z.number().optional().describe("Nova posição da lista (número, 'top', 'bottom')"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ listId, listName, newName, newPos, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const destination = selectList(await getBoardLists(creds, boardId), listId, listName);
    const targetListId = destination.id;

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
        isError: true,
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
        isError: true,
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
  "Arquiva uma lista (coluna) do quadro; com permanent e confirm, exclui a lista e seus cards em definitivo",
  {
    listId: trelloId.optional().describe("ID da lista (alternativa ao nome)"),
    listName: z.string().optional().describe("Nome exato da lista (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    permanent: z.boolean().optional().describe("Excluir em definitivo, junto com os cards da lista, em vez de arquivar. Exige confirm: true"),
    confirm: z.boolean().optional().describe("Obrigatório (true) para a exclusão permanente, que não pode ser desfeita")
  },
  async ({ listId, listName, boardUrl, permanent, confirm }) => {
    if (permanent && confirm !== true) {
      return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Exclusão permanente não executada. Ela remove a lista e seus cards e não pode ser desfeita: repita com confirm: true, ou omita permanent para apenas arquivar." }],
      };
    }

    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    const destination = selectList(await getBoardLists(creds, boardId), listId, listName);
    const targetListId = destination.id;

    try {
      // A API do Trello só exclui listas já arquivadas; arquivar é também o padrão reversível.
      await fetchTrelloWithCreds(creds, `/lists/${targetListId}/closed`, "PUT", { value: true });
      if (permanent) {
        await fetchTrelloWithCreds(creds, `/lists/${targetListId}`, "DELETE");
      }

      let text = permanent ? `✅ **Lista Excluída Permanentemente**\n\n` : `✅ **Lista Arquivada**\n\n`;
      text += `${permanent ? "🗑️" : "📦"} **${destination.name}**\n`;
      text += `🆔 ${targetListId}\n`;
      if (!permanent) text += `\nA lista foi arquivada e pode ser restaurada no Trello.\n`;
      text += `\n🔗 https://trello.com/b/${boardId}`;

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    labelId: trelloId.optional().describe("ID da label (alternativa ao nome)"),
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
      const foundLabel = pickByName(labels, labelName, "Label");
      targetLabelId = foundLabel.id;
    }
    
    if (!targetLabelId) {
      return {
        isError: true,
        content: [{ type: "text", text: "❌ Forneça labelId ou labelName" }],
      };
    }
    
    const updateData: Record<string, unknown> = {};
    
    if (newName) updateData.name = newName;
    if (newColor) updateData.color = newColor;
    
    if (Object.keys(updateData).length === 0) {
      return {
        isError: true,
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
        isError: true,
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
    labelId: trelloId.optional().describe("ID da label (alternativa ao nome)"),
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
      const foundLabel = pickByName(labels, labelName, "Label", true);
      targetLabelId = foundLabel.id;
      labelNameDeleted = foundLabel.name;
    }
    
    if (!targetLabelId) {
      return {
        isError: true,
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
        isError: true,
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
    
    const card = pickByName(await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`), cardName, "Card");
    
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    checklistId: trelloId.optional().describe("ID do checklist (alternativa ao nome)"),
    checklistName: z.string().optional().describe("Nome do checklist a renomear"),
    newName: z.string().describe("Novo nome do checklist"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, checklistId, checklistName, newName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      let targetChecklistId = checklistId;
      let oldName = checklistName || "Checklist";
      
      if (!targetChecklistId && checklistName) {
        const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name&checklists=all`);
        const checklists = cardDetails.checklists || [];
        const foundChecklist = pickByName(checklists, checklistName, "Checklist");
        targetChecklistId = foundChecklist.id;
        oldName = foundChecklist.name;
      }
      
      if (!targetChecklistId) {
        return {
          isError: true,
          content: [{ type: "text", text: "❌ Forneça checklistId ou checklistName" }],
        };
      }
      
      await fetchTrelloWithCreds(creds, `/checklists/${targetChecklistId}`, "PUT", { name: newName });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Checklist Atualizado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📝 **De:** ${oldName}\n`;
      text += `📝 **Para:** ${newName}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    
    const card = pickByName(await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`), cardName, "Card");
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = pickByName(checklists, checklistName, "Checklist");
    
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
        isError: true,
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
    
    const card = pickByName(await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`), cardName, "Card");
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = pickByName(checklists, checklistName, "Checklist");
    
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
        isError: true,
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
    
    const card = pickByName(await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`), cardName, "Card");
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = pickByName(checklists, checklistName, "Checklist");
    
    const item = pickByName(checklist.checkItems, itemName, "Item");
    
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
        isError: true,
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
    
    const card = pickByName(await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open`), cardName, "Card");
    
    const checklists = await fetchTrelloWithCreds<TrelloChecklist[]>(creds, `/cards/${card.id}/checklists`);
    const checklist = pickByName(checklists, checklistName, "Checklist");
    
    const item = pickByName(checklist.checkItems, itemName, "Item");
    
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    commentId: trelloId.optional().describe("ID do comentário (action ID) a excluir"),
    commentIndex: z.number().optional().describe("Índice do comentário (1 = mais recente, 2 = segundo mais recente, etc)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, commentId, commentIndex, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      let actionIdToDelete: string | undefined;
      
      if (commentId) {
        actionIdToDelete = commentId;
      } else if (commentIndex !== undefined) {
        const comments = await fetchTrelloWithCreds<TrelloComment[]>(creds, `/cards/${targetCardId}/actions?filter=commentCard&limit=50`);
        
        if (comments.length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "❌ Nenhum comentário encontrado neste card" }],
          };
        }
        
        const sortedComments = comments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        if (commentIndex < 1 || commentIndex > sortedComments.length) {
          return {
            isError: true,
            content: [{ 
              type: "text", 
              text: `❌ Índice inválido. O card tem ${sortedComments.length} comentário(s). Use commentIndex de 1 a ${sortedComments.length} (1 = mais recente).` 
            }],
          };
        }
        
        actionIdToDelete = sortedComments[commentIndex - 1].id;
      } else {
        return {
          isError: true,
          content: [{ 
            type: "text", 
            text: "❌ Forneça commentId (ID do comentário) ou commentIndex (número ordinal do comentário). Use trello_get_comments primeiro para ver os IDs." 
          }],
        };
      }
      
      if (!actionIdToDelete) {
        return {
          isError: true,
          content: [{ type: "text", text: "❌ Não foi possível determinar qual comentário excluir" }],
        };
      }
      
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/actions/${actionIdToDelete}/comments`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}`);
      
      let text = `✅ **Comentário Excluído**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🗑️ ID do comentário: ${actionIdToDelete}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    commentId: trelloId.optional().describe("ID do comentário (action ID) a editar"),
    commentIndex: z.number().optional().describe("Índice do comentário (1 = mais recente, 2 = segundo mais recente, etc)"),
    newText: z.string().describe("Novo texto do comentário"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, commentId, commentIndex, newText, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
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
            isError: true,
            content: [{ type: "text", text: "❌ Nenhum comentário encontrado neste card" }],
          };
        }
        
        const sortedComments = comments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        if (commentIndex < 1 || commentIndex > sortedComments.length) {
          return {
            isError: true,
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
          isError: true,
          content: [{ 
            type: "text", 
            text: "❌ Forneça commentId (ID do comentário) ou commentIndex (número ordinal do comentário). Use trello_get_comments primeiro para ver os IDs." 
          }],
        };
      }
      
      if (!actionIdToUpdate) {
        return {
          isError: true,
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
        isError: true,
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
        text += `  @${member.username}\n  🆔 ${member.id}\n`;
        if (member.avatarUrl) {
          text += `  🖼️ Avatar disponível\n`;
        }
        text += '\n';
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    email: z.string().trim().email("Email inválido").describe("Email do usuário a adicionar"),
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
        isError: true,
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
    memberId: trelloId.optional().describe("ID do membro (alternativa ao email)"),
    email: z.string().optional().describe("@username ou nome completo exato do membro (a API não expõe emails dos membros)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ memberId, email, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    let targetMemberId = memberId;
    
    if (!targetMemberId && email) {
      const members = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/boards/${boardId}/members`);
      const wanted = email.trim().toLowerCase().replace(/^@/, "");
      const matches = members.filter(m => m.username.toLowerCase() === wanted || m.fullName.trim().toLowerCase() === wanted);
      if (matches.length > 1) throw new Error("Mais de um membro corresponde a esse nome; informe memberId");
      targetMemberId = matches[0]?.id;
    }
    
    if (!targetMemberId) {
      return {
        isError: true,
        content: [{ type: "text", text: "❌ Membro não encontrado: informe memberId, o @username ou o nome completo exato" }],
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const members = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/cards/${targetCardId}/members`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      if (members.length === 0) {
        return { content: [{ type: "text", text: `👤 Nenhum membro neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `👤 **Membros do Card** (${members.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      for (const member of members) {
        text += `• **${member.fullName}** (@${member.username})\n  🆔 ${member.id}\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_add_card_member",
  "Adiciona um membro a um card do Trello",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    memberId: trelloId.describe("ID do membro a adicionar"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, memberId, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/idMembers`, "POST", { value: memberId });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Membro Adicionado ao Card**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🆔 ID do membro: ${memberId}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_remove_card_member",
  "Remove um membro de um card do Trello",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    memberId: trelloId.describe("ID do membro a remover"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, memberId, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/idMembers/${memberId}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Membro Removido do Card**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🆔 ID do membro: ${memberId}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// ==========================================
// BUSCA (SEARCH)
// ==========================================

const SEARCH_CARD_FIELDS = "fields=name,desc,shortUrl,idList,idBoard,idLabels,due,dueComplete";

function matchesQuery(card: TrelloCard, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return card.name.toLowerCase().includes(wanted) || (card.desc ?? "").toLowerCase().includes(wanted);
}

/** Lista cards com o ID, que as demais ferramentas exigem, e avisa quando há mais resultados que o exibido. */
function formatCards(cards: TrelloCard[], max = 50): string {
  let text = "";
  for (const card of cards.slice(0, max)) {
    text += `• ${card.name}\n  🆔 ${card.id}\n  🔗 ${card.shortUrl}\n\n`;
  }
  if (cards.length > max) text += `... e mais ${cards.length - max} cards não exibidos`;
  return text;
}

server.tool(
  "trello_search_cards",
  "Busca cards abertos por texto no título ou na descrição, em um quadro ou em todos os quadros abertos",
  {
    query: z.string().trim().min(1).describe("Texto para buscar (título ou descrição)"),
    boardUrl: z.string().optional().describe("Limita a busca a um quadro específico (opcional)")
  },
  async ({ query, boardUrl }) => {
    const creds = getCredentials();

    try {
      const boardIds = boardUrl
        ? [await resolveBoardId(boardUrl, creds)]
        : (await fetchTrelloWithCreds<TrelloBoard[]>(creds, "/members/me/boards")).filter(b => !b.closed).map(b => b.id);

      // Um quadro por vez: mantém a busca dentro do limite de requisições do Trello.
      const cards: TrelloCard[] = [];
      for (const id of boardIds) {
        const boardCards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${id}/cards/open?${SEARCH_CARD_FIELDS}`);
        cards.push(...boardCards.filter(card => matchesQuery(card, query)));
      }

      if (cards.length === 0) {
        return { content: [{ type: "text", text: `🔍 Nenhum card encontrado para: "${query}"` }] };
      }

      let text = `🔍 **Resultados da Busca** (${cards.length} cards em ${boardIds.length} quadro(s))\n\n`;
      text += `Busca: "${query}"\n\n`;
      text += formatCards(cards);

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_search_by_label",
  "Busca cards por etiqueta em um quadro",
  {
    labelName: z.string().trim().min(1).describe("Nome da label (exato, ou um trecho que identifique uma única label)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ labelName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      const labels = await fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`);
      const label = pickByName(labels, labelName, "Label");

      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open?${SEARCH_CARD_FIELDS}`);
      const cardsWithLabel = cards.filter(c => c.idLabels.includes(label.id));

      if (cardsWithLabel.length === 0) {
        return { content: [{ type: "text", text: `📭 Nenhum card com label "${label.name}"` }] };
      }

      let text = `🏷️ **Cards com Label "${label.name}"** (${cardsWithLabel.length})\n\n`;
      text += formatCards(cardsWithLabel);

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_search_by_due",
  "Busca cards por data de vencimento",
  {
    filter: z.enum(["overdue", "due_soon", "no_due", "all"]).describe("Filtro: overdue (atrasados e não concluídos), due_soon (vencem nos próximos 7 dias e não concluídos), no_due (sem data), all (todos com data)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ filter, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      // A listagem já traz due e dueComplete: uma requisição, em vez de uma por card.
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/open?${SEARCH_CARD_FIELDS}`);
      const now = Date.now();
      const in7Days = now + 7 * 24 * 60 * 60 * 1000;

      const filteredCards = cards.filter(card => {
        const due = card.due ? new Date(card.due).getTime() : null;
        if (filter === "no_due") return due === null;
        if (due === null) return false;
        if (filter === "all") return true;
        if (card.dueComplete) return false;
        return filter === "overdue" ? due < now : due >= now && due <= in7Days;
      });

      const filterLabels: Record<string, string> = {
        overdue: "🔴 Atrasados",
        due_soon: "⏰ Próximos 7 dias",
        no_due: "❌ Sem data",
        all: "📅 Com data"
      };

      if (filteredCards.length === 0) {
        return { content: [{ type: "text", text: `📭 Nenhum card: ${filterLabels[filter]}` }] };
      }

      let text = `${filterLabels[filter]} (${filteredCards.length})\n\n`;
      text += formatCards(filteredCards);

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const attachments = await fetchTrelloWithCreds<TrelloAttachment[]>(creds, `/cards/${targetCardId}/attachments`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      if (attachments.length === 0) {
        return { content: [{ type: "text", text: `📎 Nenhum anexo neste card\n📌 ${cardDetails.name}` }] };
      }
      
      let text = `📎 **Anexos do Card** (${attachments.length})\n\n📌 ${cardDetails.name}\n\n`;
      
      for (const att of attachments) {
        const size = att.bytes ? `${Math.round(att.bytes / 1024)}KB` : "tamanho desconhecido";
        text += `• **${att.name}**\n`;
        text += `  🆔 ${att.id}\n`;
        text += `  📊 ${size}\n`;
        text += `  🔗 ${att.url}\n`;
        if (att.mimeType) text += `  📋 ${att.mimeType}\n`;
        text += '\n';
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_delete_attachment",
  "Exclui um anexo de um card do Trello",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    attachmentId: trelloId.describe("ID do anexo a excluir"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, attachmentId, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/attachments/${attachmentId}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Anexo Excluído**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `🆔 ID: ${attachmentId}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    limit: z.number().int().min(1).max(1000).optional().describe("Número de atividades (padrão: 20)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, limit = 20, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const actions = await fetchTrelloWithCreds<any[]>(creds, `/cards/${targetCardId}/actions?limit=${limit}`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
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
        isError: true,
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
      const overdueCards = cards.filter(c => c.due && !c.dueComplete && new Date(c.due) < now).length;
      
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
      text += `  🔴 Atrasados: ${overdueCards}\n`;
      
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
        isError: true,
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
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const me = await fetchTrelloWithCreds<{ id: string }>(creds, "/members/me");
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/membersVoted`, "POST", { value: me.id });
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Voto Adicionado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_unvote_card",
  "Remove o voto de um card",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const me = await fetchTrelloWithCreds<{ id: string }>(creds, "/members/me");
      await fetchTrelloWithCreds(creds, `/cards/${targetCardId}/membersVoted/${me.id}`, "DELETE");
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Voto Removido**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `\n🔗 ${cardDetails.shortUrl}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_list_card_votes",
  "Lista os votos de um card",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const votes = await fetchTrelloWithCreds<TrelloMember[]>(creds, `/cards/${targetCardId}/membersVoted`);
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
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
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_upload_attachment",
  "Faz upload de um anexo para um card",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    fileUrl: z.string().trim().url("URL inválida").refine(value => /^https?:\/\//i.test(value), "Use uma URL http(s)").describe("URL pública (http/https) do arquivo; o Trello baixa o arquivo dessa URL"),
    fileName: z.string().optional().describe("Nome do arquivo (opcional, será extraído da URL se não fornecido)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, fileUrl, fileName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
    try {
      const name = fileName || fileUrl.split("/").pop() || "arquivo";
      
      const attachment = await fetchTrelloWithCreds<TrelloAttachment>(creds, `/cards/${targetCardId}/attachments`, "POST", {
        url: fileUrl,
        name: name
      });
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `✅ **Anexo Enviado**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📎 Arquivo: ${attachment.name}\n`;
      text += `🔗 ${attachment.url}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_download_attachment",
  "Obtém a URL de download de um anexo",
  {
    cardId: trelloId.optional().describe("ID do card (alternativa ao nome)"),
    cardName: z.string().optional().describe("Nome ou parte do nome do card (alternativa ao ID)"),
    attachmentId: trelloId.optional().describe("ID do anexo (alternativa ao nome)"),
    attachmentName: z.string().optional().describe("Nome do anexo (alternativa ao ID)"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)")
  },
  async ({ cardId, cardName, attachmentId, attachmentName, boardUrl }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    const targetCardId = await resolveCardId(creds, boardId, cardId, cardName);
    
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
        return { isError: true, content: [{ type: "text", text: "❌ Anexo não encontrado" }] };
      }
      
      const cardDetails = await fetchTrelloWithCreds<TrelloCardDetails>(creds, `/cards/${targetCardId}?fields=name,shortUrl`);
      
      let text = `📥 **Download de Anexo**\n\n`;
      text += `📌 Card: ${cardDetails.name}\n`;
      text += `📎 Arquivo: ${targetAttachment.name}\n`;
      text += `📋 Tipo: ${targetAttachment.mimeType}\n`;
      text += `\n🔗 **URL de Download:**\n${targetAttachment.url}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

interface TrelloPlugin {
  id: string;
  name?: string;
  listing?: { name?: string };
}

const pluginName = (plugin: TrelloPlugin) => plugin.listing?.name || plugin.name || "(sem nome)";

function powerUpError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Erro";
  return /\b403\b/.test(message) ? `O Trello recusou a operação (403). A API pública marca esta rota como obsoleta e pode não permitir ativar ou desativar Power-Ups com token de API; nesse caso, altere pelo menu Power-Ups do quadro.` : message;
}

server.tool(
  "trello_list_power_ups",
  "Lista os Power-Ups ativados no quadro, com IDs. Com search, também procura Power-Ups disponíveis para ativar",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    search: z.string().trim().min(1).optional().describe("Trecho do nome para procurar entre os Power-Ups disponíveis (opcional)")
  },
  async ({ boardUrl, search }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);
      const enabled = await fetchTrelloWithCreds<TrelloPlugin[]>(creds, `/boards/${boardId}/plugins?filter=enabled`);

      let text = `⚡ **Power-Ups do Quadro**\n\n📋 ${board.name}\n\n`;

      if (enabled.length === 0) {
        text += "Nenhum Power-Up ativado.\n";
      } else {
        text += `Ativados (${enabled.length}):\n`;
        for (const plugin of enabled) {
          text += `  ✅ ${pluginName(plugin)}\n     🆔 ${plugin.id}\n`;
        }
      }

      if (search) {
        const available = await fetchTrelloWithCreds<TrelloPlugin[]>(creds, `/boards/${boardId}/plugins?filter=available`);
        const wanted = search.toLowerCase();
        const enabledIds = new Set(enabled.map(plugin => plugin.id));
        const matches = available.filter(plugin => !enabledIds.has(plugin.id) && pluginName(plugin).toLowerCase().includes(wanted));
        text += `\nDisponíveis com "${search}" (${matches.length}):\n`;
        for (const plugin of matches.slice(0, 20)) {
          text += `  • ${pluginName(plugin)}\n     🆔 ${plugin.id}\n`;
        }
        if (matches.length > 20) text += `  ... e mais ${matches.length - 20}; refine a busca\n`;
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_enable_power_up",
  "Ativa um Power-Up no quadro. Usa uma rota obsoleta da API, que o Trello pode recusar (403) para tokens de API",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    powerUpId: trelloId.describe("ID do Power-Up, obtido em trello_list_power_ups com search")
  },
  async ({ boardUrl, powerUpId }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      await fetchTrelloWithCreds(creds, `/boards/${boardId}/boardPlugins`, "POST", { idPlugin: powerUpId });

      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);

      let text = `✅ **Power-Up Ativado**\n\n`;
      text += `📋 Quadro: ${board.name}\n`;
      text += `⚡ ID: ${powerUpId}`;

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${powerUpError(error)}` }],
      };
    }
  }
);

server.tool(
  "trello_disable_power_up",
  "Desativa um Power-Up no quadro. Usa uma rota obsoleta da API, que o Trello pode recusar (403) para tokens de API",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    powerUpId: trelloId.describe("ID do Power-Up ativado, obtido em trello_list_power_ups")
  },
  async ({ boardUrl, powerUpId }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      await fetchTrelloWithCreds(creds, `/boards/${boardId}/boardPlugins/${powerUpId}`, "DELETE");

      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);

      let text = `✅ **Power-Up Desativado**\n\n`;
      text += `📋 Quadro: ${board.name}\n`;
      text += `⚡ ID: ${powerUpId}`;

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${powerUpError(error)}` }],
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
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_create_webhook",
  "Cria um novo webhook",
  {
    callbackURL: z.string().trim().url("URL inválida").refine(value => value.startsWith("https://"), "O callback deve usar HTTPS").describe("URL HTTPS de callback; recebe todas as atividades do modelo"),
    modelId: trelloId.describe("ID do modelo (board ou card)"),
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
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_delete_webhook",
  "Deleta um webhook",
  {
    webhookId: trelloId.describe("ID do webhook a deletar")
  },
  async ({ webhookId }) => {
    const creds = getCredentials();
    
    try {
      await fetchTrelloWithCreds(creds, `/webhooks/${webhookId}`, "DELETE");
      
      return { content: [{ type: "text", text: `✅ **Webhook Deletado**\n\n🆔 ${webhookId}` }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

server.tool(
  "trello_search_in_board",
  "Pesquisa cards visíveis de um quadro por texto no título ou na descrição, com limite de resultados",
  {
    query: z.string().trim().min(1).describe("Termo de busca"),
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    limit: z.number().int().min(1).max(1000).optional().describe("Máximo de resultados exibidos (padrão: 25)")
  },
  async ({ query, boardUrl, limit = 25 }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      // Filtra antes de limitar: o limite vale para os resultados, não para os cards examinados.
      const cards = await fetchTrelloWithCreds<TrelloCard[]>(creds, `/boards/${boardId}/cards/visible?${SEARCH_CARD_FIELDS}`);
      const matchingCards = cards.filter(card => matchesQuery(card, query));

      const board = await fetchTrelloWithCreds<{ name: string }>(creds, `/boards/${boardId}?fields=name`);

      if (matchingCards.length === 0) {
        return { content: [{ type: "text", text: `🔍 Nenhum resultado para "${query}" em ${board.name}` }] };
      }

      let text = `🔍 **Resultados da Busca**\n\n`;
      text += `📋 Quadro: ${board.name}\n`;
      text += `🔎 Query: "${query}"\n`;
      text += `📝 Encontrados: ${matchingCards.length}\n\n`;
      text += formatCards(matchingCards, limit);

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

// Aspas duplicadas conforme a RFC 4180; o apóstrofo inicial impede que planilhas executem o texto como fórmula.
function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

server.tool(
  "trello_export_board",
  "Exporta listas, cards abertos, etiquetas e membros de um quadro. Devolve o conteúdo em JSON, ou em CSV com uma linha por card",
  {
    boardUrl: z.string().optional().describe("URL ou nome do quadro (opcional)"),
    format: z.enum(["json", "csv"]).optional().describe("Formato de export (padrão: json)")
  },
  async ({ boardUrl, format = "json" }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);

    try {
      const [board, lists, cards, labels, members] = await Promise.all([
        fetchTrelloWithCreds<{ id: string; name: string; desc: string; url: string }>(creds, `/boards/${boardId}?fields=name,desc,url`),
        fetchTrelloWithCreds<TrelloList[]>(creds, `/boards/${boardId}/lists`),
        fetchTrelloWithCreds<(TrelloCard & { idMembers: string[] })[]>(creds, `/boards/${boardId}/cards/open?fields=name,desc,idList,idLabels,idMembers,due,dueComplete,shortUrl`),
        fetchTrelloWithCreds<TrelloBoardLabel[]>(creds, `/boards/${boardId}/labels`),
        fetchTrelloWithCreds<TrelloMember[]>(creds, `/boards/${boardId}/members`),
      ]);

      const listName = new Map(lists.map(l => [l.id, l.name]));
      const labelName = new Map(labels.map(l => [l.id, l.name || l.color]));
      const memberName = new Map(members.map(m => [m.id, m.username]));
      const rows = cards.map(c => ({
        id: c.id,
        name: c.name,
        list: listName.get(c.idList) ?? c.idList,
        labels: c.idLabels.map(id => labelName.get(id) ?? id),
        members: (c.idMembers ?? []).map(id => memberName.get(id) ?? id),
        due: c.due ?? null,
        dueComplete: c.dueComplete ?? false,
        url: c.shortUrl,
        desc: c.desc ?? "",
      }));

      let data: string;
      if (format === "csv") {
        const header = ["id", "name", "list", "labels", "members", "due", "dueComplete", "url", "desc"];
        const lines = rows.map(r => [r.id, r.name, r.list, r.labels.join("; "), r.members.join("; "), r.due ?? "", r.dueComplete, r.url, r.desc].map(csvCell).join(","));
        data = [header.join(","), ...lines].join("\r\n");
      } else {
        data = JSON.stringify({
          exportedAt: new Date().toISOString(),
          board: { id: board.id, name: board.name, desc: board.desc, url: board.url },
          lists: lists.map(l => ({ id: l.id, name: l.name })),
          labels: labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
          members: members.map(m => ({ id: m.id, fullName: m.fullName, username: m.username })),
          cards: rows,
        }, null, 2);
      }

      let text = `📤 **Quadro Exportado** (${format.toUpperCase()})\n\n`;
      text += `📋 ${board.name}\n`;
      text += `  📝 Listas: ${lists.length}\n`;
      text += `  📌 Cards abertos: ${cards.length}\n`;
      text += `  🏷️ Labels: ${labels.length}\n`;
      text += `  👥 Membros: ${members.length}\n\n`;
      text += `O conteúdo exportado está no bloco seguinte.`;

      return { content: [{ type: "text", text }, { type: "text", text: data }] };
    } catch (error) {
      return {
        isError: true,
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
    templateId: trelloId.optional().describe("ID do template (opcional)"),
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
        isError: true,
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
    limit: z.number().int().min(1).max(1000).optional().describe("Limite de resultados (padrão: 20)")
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
        isError: true,
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
    days: z.number().int().min(1).max(365).optional().describe("Dias de histórico (padrão: 30)")
  },
  async ({ boardUrl, days = 30 }) => {
    const creds = getCredentials();
    const boardId = await resolveBoardId(boardUrl, creds);
    
    try {
      const actions = await fetchTrelloWithCreds<TrelloAction[]>(
        creds, 
        `/boards/${boardId}/actions?limit=1000&since=${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()}`
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
        isError: true,
        content: [{ type: "text", text: `❌ Erro: ${error instanceof Error ? error.message : "Erro"}` }],
      };
    }
  }
);

registerPlatformTools(server, {
  request: (endpoint, method, body) => fetchTrelloWithCreds(getCredentials(), endpoint, method, body),
  resolveBoard: (input) => resolveBoardId(input, getCredentials()),
});

registerWorkflowTools(server, {
  request: (endpoint, method, body) => fetchTrelloWithCreds(getCredentials(), endpoint, method, body),
  resolveBoard: (input) => resolveBoardId(input, getCredentials()),
});

main().catch(console.error);
