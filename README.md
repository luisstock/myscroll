# MyScroll

Uma edição diária com curadoria: curiosidades, fun, motion, AI, gravel, tech, ciência, design e Portugal. Serve para substituir o doomscroll. Os itens que não lês ficam guardados para o dia seguinte. No fim do feed há um botão **Load more** para pedir mais na hora.

## Como funciona o agente diário (barato)

```
plan → recolha (RSS, Reddit, YouTube, Hacker News, Wikipedia)  ← sem AI, grátis
     → pré-seleção pelo teu gosto + histórico (nunca repete)    ← sem AI
     → extração do texto real dos artigos (Readability)         ← sem AI
     → escrita: 1 pedido por tópico (Gemini / Ollama / Claude)  ← único passo com modelo
     → finalize: valida, tira repetidos, imagens, publica
```

- Modelo: `provider` em [myscroll.config.json](myscroll.config.json) (`gemini` | `ollama` | `claude`). As chaves vêm de variáveis de ambiente (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`), nunca do ficheiro.
- `data/history.json` guarda tudo o que já foi mostrado, para nunca receberes a mesma coisa.
- Corre todos os dias no GitHub Actions ([.github/workflows/daily.yml](.github/workflows/daily.yml)) e publica a app no GitHub Pages.

```bash
npm install
node scripts/pipeline/run.mjs --dry      # tudo menos o modelo; guarda data/candidates-<data>.json
node scripts/pipeline/run.mjs            # edição de hoje
node scripts/pipeline/run.mjs --more 15  # Load more: acrescenta ~15 itens a hoje
node scripts/pipeline/run.mjs --more 15 --sub ai/frontier         # Load more só de uma subcategoria
node scripts/pipeline/run.mjs --more 10 --query "gravel tyres"    # Pesquisa na web (Google News, Reddit, HN, Wikipedia) + 1 chamada ao modelo
node scripts/pipeline/run.mjs --url https://…                     # Partilhar: 1 item a partir de um link (artigo, Reddit, YouTube)
```

## Estrutura

- `web/`: a app (HTML/CSS/JS, sem build). `app.js` (feed), `settings.js`, `model.js` (estado e regras), `readmore.js`, `loadmore.js`, `ranking.js` (gosto, ver [docs/ranking.md](docs/ranking.md)), `taxonomy.json` (tópicos e grupos), `catalog.json` (fontes).
- `scripts/pipeline/`: o agente diário (`run.mjs`, `gather.mjs`, `search.mjs` (pesquisa e partilha), `select.mjs`, `extract.mjs`, `write.mjs`, `llm.mjs`, `history.mjs`).
- `scripts/agent/`: `plan.mjs` e `finalize.mjs` (partilhados), `context.mjs`.
- `scripts/serve.mjs`: servidor local: app, Read more (`/api/fetch`), sincronização (`/api/state`) Load more / pesquisa / partilha (`/api/run?more=&topics=&sub=&query=&url=`) e Ask/traduzir (`POST /api/llm`).

## Testar no PC

```bash
node scripts/serve.mjs
```

Abrir http://localhost:5173. Para o Load more funcionar localmente, arranca o servidor com `GEMINI_API_KEY` definida.

## Partilhar do Android

A app aparece no menu Partilhar de qualquer app (texto/links, `ShareInPlugin` em `android/`). O link vai para Read later e o agente escreve o item (`--url`).

## Seguir uma história

O run diário lê `follows` do estado sincronizado: para cada uma pesquisa os últimos 7 dias (desde `since`), tira o que já foi mostrado e escreve até 2 atualizações (`follow`) numa só chamada ao modelo.
