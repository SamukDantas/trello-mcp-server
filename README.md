# Trello MCP Server

MCP (Model Context Protocol) server para integração com o Trello. Permite gerenciar tarefas e quadros do Trello diretamente de assistentes de IA como o OpenCode CLI.

## Funcionalidades

### Gerenciamento de Quadros
- `trello_list_boards` - Lista todos os quadros do usuário
- `trello_set_board` - Define o quadro ativo para operações

### Gerenciamento de Tarefas
- `trello_tasks` - Lista tarefas pendentes no backlog
- `trello_list_all` - Lista todas as tarefas do quadro ativo
- `trello_list_by_list` - Lista tarefas de uma lista específica (backlog, doing, testing, done)
- `trello_get_card_details` - Exibe detalhes completos de uma tarefa

### Fluxo de Trabalho
- `trello_next` - Inicia a próxima tarefa (move para Doing)
- `trello_status` - Mostra a tarefa atual em andamento
- `trello_done` - Marca tarefa como concluída (move para Testing)
- `trello_create` - Cria nova tarefa no backlog

## Instalação

1. Clone o repositório
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Compile o TypeScript:
   ```bash
   npm run build
   ```

## Configuração

Crie um arquivo de configuração em `~/.config/opencode/trello-config.json`:

```json
{
  "apiKey": "sua-api-key",
  "token": "seu-token",
  "boardId": "id-do-quadro-padrao",
  "lists": {
    "backlog": "id-lista-backlog",
    "doing": "id-lista-doing",
    "testing": "id-lista-testing",
    "done": "id-lista-done"
  },
  "labels": {
    "pontoFocal": "id-label-ponto-focal"
  }
}
```

### Obtendo Credenciais do Trello

1. Acesse https://trello.com/app-key para obter sua API Key
2. Gere um token com permissões de leitura/escrita:
   ```
   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=OpenCode&key=SUA_API_KEY
   ```

## Uso com OpenCode CLI

Adicione ao seu `opencode.json`:

```json
{
  "mcp": {
    "trello": {
      "type": "local",
      "command": ["node", "/caminho/para/trello-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

## Multi-Quadro

O MCP suporta trabalhar com múltiplos quadros:

```bash
# Listar todos os quadros
trello_list_boards

# Definir quadro ativo
trello_set_board boardUrl="https://trello.com/b/xxx/nome-quadro"

# Listar tarefas de um quadro específico
trello_list_by_list listName="done" boardUrl="https://trello.com/b/xxx/nome-quadro"
```

## Detalhes de Tarefa

A função `trello_get_card_details` retorna informações completas:
- Descrição
- Labels com cores
- Membros atribuídos
- Anexos com links
- Checklists com progresso
- Comentários
- Data de criação e última atividade
- Vencimento (com aviso de atrasada)

## Licença

MIT
