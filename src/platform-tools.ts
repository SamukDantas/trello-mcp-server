import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface PlatformApi {
  request<T>(endpoint: string, method?: "GET" | "POST" | "PUT", body?: object): Promise<T>;
  resolveBoard(input?: string): Promise<string>;
}

type FieldType = "text" | "number" | "date" | "checkbox" | "list";
interface CustomField {
  id: string;
  idModel: string;
  name: string;
  type: FieldType;
  options?: { id: string; value: { text: string } }[];
}
interface FieldItem {
  idCustomField: string;
  idValue?: string;
  value?: Record<string, string>;
}
const id = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Informe o ID Trello de 24 caracteres");
const board = { boardUrl: z.string().trim().min(1).optional().describe("URL, ID ou nome do quadro; padrão: quadro ativo") };
const card = { cardId: id.describe("ID do card, inclusive arquivado") };

async function result(operation: () => Promise<unknown>) {
  try {
    const data = await operation();
    return { content: [{ type: "text" as const, text: JSON.stringify(data ?? {}, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: `Erro: ${error instanceof Error ? error.message : "Falha na operação Trello"}` }] };
  }
}

export function registerPlatformTools(server: McpServer, api: PlatformApi) {
  server.tool("trello_list_custom_fields", "Lista campos personalizados do quadro, seus tipos e IDs das opções", board,
    async ({ boardUrl }) => result(async () => api.request(`/boards/${await api.resolveBoard(boardUrl)}/customFields`)));

  server.tool("trello_create_custom_field", "Cria um campo personalizado no quadro (requer disponibilidade do recurso no Trello)", {
    ...board,
    name: z.string().trim().min(1).describe("Nome do campo"),
    type: z.enum(["text", "number", "date", "checkbox", "list"]),
    options: z.array(z.string().trim().min(1)).min(1).max(50).optional().describe("Opções obrigatórias apenas para campos list"),
  }, async ({ boardUrl, name, type, options }) => result(async () => {
    if (type === "list" && !options) throw new Error("Campos list exigem opções");
    if (type !== "list" && options) throw new Error("Somente campos list aceitam opções");
    if (options && new Set(options.map(value => value.toLowerCase())).size !== options.length) {
      throw new Error("As opções devem ser únicas");
    }
    return api.request("/customFields", "POST", {
      idModel: await api.resolveBoard(boardUrl), modelType: "board", name, type, pos: "bottom",
      ...(options ? { options: options.map((text, index) => ({ value: { text }, pos: (index + 1) * 16384 })) } : {}),
    });
  }));

  server.tool("trello_get_card_custom_fields", "Lê campos personalizados do card com nomes, tipos e valores legíveis", card,
    async ({ cardId }) => result(async () => {
      const details = await api.request<{ idBoard: string }>(`/cards/${cardId}?fields=idBoard`);
      const [fields, items] = await Promise.all([
        api.request<CustomField[]>(`/boards/${details.idBoard}/customFields`),
        api.request<FieldItem[]>(`/cards/${cardId}/customFieldItems`),
      ]);
      return fields.map(field => {
        const item = items.find(value => value.idCustomField === field.id);
        return {
          id: field.id, name: field.name, type: field.type,
          value: field.type === "list"
            ? field.options?.find(option => option.id === item?.idValue)?.value.text ?? null
            : item?.value?.[field.type === "checkbox" ? "checked" : field.type] ?? null,
          ...(item?.idValue ? { optionId: item.idValue } : {}),
        };
      });
    }));

  server.tool("trello_set_card_custom_field", "Preenche campo personalizado; value=null limpa o valor. Para list, informe o ID da opção", {
    ...card,
    customFieldId: id,
    value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).describe("Texto, número, data ISO com fuso, booleano, ID da opção ou null"),
  }, async ({ cardId, customFieldId, value }) => result(async () => {
    const [details, field] = await Promise.all([
      api.request<{ idBoard: string }>(`/cards/${cardId}?fields=idBoard`),
      api.request<CustomField>(`/customFields/${customFieldId}`),
    ]);
    if (details.idBoard !== field.idModel) throw new Error("O campo não pertence ao quadro do card");
    let body: object;
    if (value === null) {
      body = { idValue: "", value: "" };
    } else {
      switch (field.type) {
        case "text":
          if (typeof value !== "string") throw new Error("Campo text exige texto");
          body = { value: { text: value } };
          break;
        case "number":
          if (typeof value !== "number") throw new Error("Campo number exige número");
          body = { value: { number: String(value) } };
          break;
        case "checkbox":
          if (typeof value !== "boolean") throw new Error("Campo checkbox exige true ou false");
          body = { value: { checked: String(value) } };
          break;
        case "date": {
          const parsed = z.string().datetime({ offset: true }).safeParse(value);
          if (!parsed.success) throw new Error("Campo date exige data ISO 8601 com fuso horário");
          body = { value: { date: new Date(parsed.data).toISOString() } };
          break;
        }
        case "list":
          if (typeof value !== "string" || !field.options?.some(option => option.id === value)) {
            throw new Error("Informe um ID de opção pertencente ao campo (consulte trello_list_custom_fields)");
          }
          body = { idValue: value };
          break;
        default: throw new Error("Tipo de campo não suportado");
      }
    }
    await api.request(`/cards/${cardId}/customField/${customFieldId}/item`, "PUT", body);
    return { cardId, customFieldId, cleared: value === null, updated: true };
  }));

  server.tool("trello_list_archived_cards", "Lista cards arquivados do quadro com IDs para restauração", board,
    async ({ boardUrl }) => result(async () => api.request(`/boards/${await api.resolveBoard(boardUrl)}/cards?filter=closed&fields=name,idList,shortUrl,closed`)));

  server.tool("trello_set_card_archived", "Arquiva um card ou o restaura para sua lista original", {
    ...card, archived: z.boolean().describe("true arquiva; false restaura"),
  }, async ({ cardId, archived }) => result(async () => {
    await api.request(`/cards/${cardId}`, "PUT", { closed: archived });
    return { cardId, archived };
  }));

  server.tool("trello_set_card_subscription", "Ativa ou desativa acompanhar um card para o usuário autenticado", {
    ...card, subscribed: z.boolean().describe("true acompanha; false deixa de acompanhar"),
  }, async ({ cardId, subscribed }) => result(async () => {
    await api.request(`/cards/${cardId}`, "PUT", { subscribed });
    return { cardId, subscribed };
  }));
}
