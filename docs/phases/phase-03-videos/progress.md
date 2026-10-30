# phase-03-videos — Progress

**Status:** completed
**SIs:** 18/18 completed

### SI-03.1 — Infra: Redis, RustFS e FFmpeg no ambiente Docker
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verificados: redis/rustfs healthy, ffmpeg/ffprobe 5.1.9 no container, `http://rustfs:9000/health` → 200
- **Observations:**
  - Porta 9000 do host já está ocupada (container `pega-transcript-rustfs-1`, outro projeto). A porta publicada do RustFS virou `${S3_HOST_PORT:-9000}:9000` (default do plano preservado); o `.env` local usa `S3_HOST_PORT=9004` e `S3_PUBLIC_ENDPOINT=http://localhost:9004`. `.env.example` ganhou `S3_HOST_PORT=9000` documentado.
  - Credenciais do RustFS vêm de `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` do `.env` via interpolação do Compose (fonte única); `RUSTFS_CORS_ALLOWED_ORIGINS` vem de `S3_CORS_ALLOWED_ORIGINS`.
  - Containers órfãos de uma tentativa anterior (`minio`, `video-worker`, volume `nestjs-project_minio_data`) seguem rodando; não foram removidos. O `db` em execução não publica 5432, mas o `compose.yaml` publica `5432:5432` (conflita com `pega-transcript-postgres-1`): um `docker compose up -d` completo tentaria recriar o `db` e falharia. Subi só `redis`, `rustfs` e `nestjs-api` com `--no-deps`. Fora de escopo.
  - `.env` local: removido o bloco antigo (`S3_ENDPOINT=http://minio:9000`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) e substituído pelos nomes decididos no TD-04.
  - O `nestjs-api` foi recriado com a porta `3000:3000` do `compose.yaml` (antes rodava em 3010 por config antiga não versionada).

### SI-03.2 — Infra: dependências e namespaces de configuração de storage e fila
- **Status:** completed
- **Tests:** 9 passing (`env.validation.spec.ts` 5 + `env.validation.integration-spec.ts` 4); `tsc --noEmit` ok
- **Observations:**
  - `src/config/env.validation.integration-spec.ts` (pré-existente, Fase 01) precisou receber as novas variáveis S3 obrigatórias no `requiredEnv`, senão quebraria. O arquivo é um teste unitário puro com sufixo de integração; renomeá-lo fica fora de escopo.
  - AC "A API sobe sem erro" verificado validando o `.env` real contra o schema (sem subir o servidor, conforme CLAUDE.md); sem `S3_BUCKET` a validação falha com `"S3_BUCKET" is required`.

### SI-03.3 — Módulo de storage com clientes interno e público
- **Status:** completed
- **Tests:** 16 passing (storage.module.spec, storage.service.integration-spec, storage-bootstrap.service.integration-spec); tsc e eslint ok
- **Observations:** 
- Os dois `S3Client` usam `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`: com os defaults do SDK ^3.1160, a URL assinada de `UploadPart` leva `x-amz-checksum-crc32` de corpo vazio e o RustFS responde 400 `BadDigest` (gotcha já citada em `library-refs.md`; também necessária para uploads do navegador no S3).
  - Regra CORS do bucket ganhou `AllowedHeaders: ['*']` (não listado no plano), necessário para o preflight do PUT com `Content-Type`.
  - `listParts` já pagina internamente até o fim e devolve as partes ordenadas por número.
  - Criado helper `src/test/storage.ts` (bucket descartável `streamtube-test-<uuid>` por suíte); o bucket de dev não é tocado.
  - Testes que sobem o `AppModule` passam a executar o bootstrap do bucket no RustFS real (`S3_BUCKET`), então `rustfs` precisa estar de pé nas suítes e2e.

### SI-03.4 — Gate de compatibilidade do storage (RustFS)
- **Status:** completed
- **Tests:** 10 passing (storage-compat.integration-spec); storage completo 26/26; tsc e eslint ok
- **Observations:** 
- **Gate aprovado:** RustFS `rustfs/rustfs:1.0.4` passou em todas as verificações; TD-02 mantido, sem fallback para MinIO.
  - **AC de CORS adaptado:** o RustFS não devolve `Access-Control-Expose-Headers` no preflight `OPTIONS`, só na resposta real do PUT (`access-control-expose-headers: ETag`). Pelo Fetch Standard o navegador lê os headers expostos da resposta real e ignora esse header no preflight, então o ETag continua legível. O teste valida o preflight (origin/método PUT/header content-type) e, separadamente, o `Expose-Headers: ETag` no PUT real. A redação do AC 4 e da ação 2 do SI-03.4 no plano ficou imprecisa (não editei o plano para não invalidar as specs).
  - Nome de arquivo não-ASCII (`filename*=UTF-8''v%C3%ADdeo.mp4`) volta byte a byte no GET assinado — o item opcional da validação ficou coberto.
  - `src/test/video-fixture.ts` gera via ffmpeg um MP4 de ~11 MB (3 s, com ruído para passar de 5 MiB e permitir 2 partes) e um arquivo de controle não-vídeo; nada binário versionado.

### SI-03.5 — Entidade Video, migration e gerador de slug
- **Status:** completed
- **Tests:** 11 passing (video-slug.util.spec, video.entity.integration-spec, migrations.integration-spec) no banco de dev após a migration; tsc e eslint ok
- **Observations:** 
- Banco de dev tinha uma tabela `videos` órfã de tentativa anterior (schema antigo, 2 linhas e2e) e o registro `CreateVideos1792660000000` sem arquivo; o usuário executou o `DROP TABLE` + `DELETE` e a nova migration `CreateVideos1793344583732` foi aplicada no `streamtube`. Banco temporário `streamtube_si035` (criado pelo subagente) ainda existe e pode ser removido.
  - `src/database/migrations.integration-spec.ts` (Fase 02) atualizado para incluir `Video`/`CreateVideos`; corrigidos dois bugs pré-existentes: o `beforeAll` não removia `verification_tokens_type_enum` e os `DROP TABLE` concorrentes entravam em deadlock após a FK `videos → channels`.
  - Relação só com `@ManyToOne` (sem `@OneToMany` em `Channel`) para não quebrar `AppModule`/test data sources antes do registro da entidade no SI-03.8.
  - Fora de escopo: `createTestDataSource` lê `DB_DATABASE`, enquanto `database.config.ts`/`.env` usam `DB_NAME` (funciona só porque ambos têm default `streamtube`).

### SI-03.6 — Infra: BullMQ na API e módulo de banco compartilhável
- **Status:** completed
- **Tests:** 6 passing (queue.module.integration-spec, database.module.integration-spec); e2e 52/52 e suíte unit+integration 190/190 como regressão; tsc ok
- **Observations:** 
- **Dependência extra:** `ioredis@^5.11.1` instalado — no bullmq 6.5.1 ele virou peer opcional e a criação de fila falhava sem ele (não previsto no plano nem no library-refs).
  - bullmq v6 removeu `queue.client`; teste usa `waitUntilReady()` e `queue.opts.connection`. Com Redis inacessível, `queue.disconnect()` não resolve — usar `queue.close()` no teardown.
  - Corrigido bug do SI-03.2: em `test/jest-e2e.json` o `rootDir` é `test/`, então o setup file correto é `<rootDir>/../src/test/setup-test-env.ts` (antes todo e2e falhava com "setupFiles not found").
  - Regressão: e2e 52/52, unit+integration 190/190.
  - **Dívida de lint pré-existente:** `npm run lint` acusa ~150 erros em 11 arquivos das Fases 01/02 (`auth.service.spec.ts`, `test/auth.e2e-spec.ts`, `mail.service.integration-spec.ts`, `channels.service.ts`, etc.). O único arquivo da Fase 03 na lista (`env.validation.spec.ts`, SI-03.2) foi corrigido pelo coordenador. Precisa de tarefa separada.

### SI-03.7 — Infra: entrypoint do worker e fronteira entre módulos
- **Status:** completed
- **Tests:** 5 passing (worker.module.integration-spec); regressão unit+integration 195/195, e2e 52/52; tsc ok; eslint ok nos arquivos tocados
- **Observations:** 
- **`command` do `video-worker` diferente do plano:** `npm run start:worker:dev` sozinho fazia `docker compose stop` sair com código 1 sem rodar os shutdown hooks (o watcher do Nest CLI morre no SIGTERM e o app leva SIGKILL). O serviço roda `sh -c` com o mesmo script em background + `trap` que repassa SIGTERM ao processo `node … dist/worker` e espera ele sair (comentado no compose). O `nestjs-api` tem o mesmo problema com `start:dev` (fora de escopo).
  - `src/config/config-module.options.ts` centraliza `load`/`validationSchema` usados por `AppModule` e `WorkerModule` (alterou `app.module.ts` do SI-03.6, mesmo comportamento).
  - `src/video-processing/index.ts` passou a exportar `VideoProcessingModule` para o worker não precisar de deep import (proibido pela nova regra `no-restricted-imports`).
  - O container órfão `video-worker` foi adotado pelo novo serviço; está rodando e logou "Video worker started".
  - Fora de escopo: worker e API dev server compartilham `dist/` e `tsconfig.tsbuildinfo` com `deleteOutDir: true` — subir `start:dev` na API apaga o `dist/` do worker em execução (ele reconstrói, mas reinicia). Um `outDir` separado para o worker resolveria.
  - Considerar `stop_grace_period` maior no `video-worker` quando o processor de FFmpeg chegar (SI-03.13).

### SI-03.8 — Endpoint POST /videos (pré-cadastro do rascunho e início do upload)
- **Status:** completed
- **Tests:** 33 passing (video-upload.service.spec 11, video-upload.service.integration-spec 3, videos.module.spec 2, channels.service.integration-spec, videos-create.e2e-spec 4); regressão e2e 56/56, unit+integration 213/213; tsc ok
- **Observations:** 
- `VideosModule` registrado no `AppModule`; `ChannelsService.findByUserId` adicionado (+2 testes de integração).
  - Relação inversa `@OneToMany` em `Channel` **não** adicionada: nada precisa dela e obrigaria incluir `Video` em todas as listas de entidades dos testes das Fases 01/02.
  - Após o insert o service recarrega a linha (`findOneByOrFail`) para que colunas nulas de metadados apareçam na resposta; a recarga fica fora do bloco protegido por abort.
  - Usuário sem canal → `Error` simples (500): invariante interna, o Error Catalog não tem código para ela.
  - Se o `AbortMultipartUpload` de compensação falhar, é logado e o erro original do insert é relançado (o lifecycle de 2 dias limpa depois).
  - Título padrão = nome do arquivo sem extensão, truncado em 100 caracteres (`title` é `varchar(100)`, `filename` aceita 255) — truncamento não especificado no plano.
  - O e2e aborta no `afterEach` os multipart uploads que abre no bucket de dev.
  - Headings de API Contracts no plano trazem números de SI errados (ex.: `#### POST /videos (SI-03.6)`), só documentação.
  - Helper de unique-violation do slug é local e tipado; o helper antigo `isPgUniqueViolationOnColumn` em `channels.service.ts` continua com erros de lint pré-existentes.

### SI-03.9 — Endpoint POST /videos/:id/upload/part-urls
- **Status:** completed
- **Tests:** 38 passing em src/videos (inclui videos.service.integration-spec 6, signPartUrls 8 unit) + videos-upload-part-urls.e2e-spec 5/5; regressão e2e 61/61, unit+integration 227/227; tsc ok
- **Observations:** 
- Criados `video.exceptions.ts` (6 exceções do Error Catalog) e `VideosService.findOwnedById/findOwnedBySlug` (join com `channel.user_id`; inexistente e de outro canal → `VIDEO_NOT_FOUND`).
  - `upload-limits.ts` ganhou `MAX_PART_URLS_PER_REQUEST = 100`.
  - Vídeo `pending_upload` sem `upload_id` → `Error` simples (500): estado impossível, sem código no catálogo (mesmo critério do SI-03.8).
  - `:id` não-uuid → 400 `VALIDATION_ERROR` via `ParseUUIDPipe` + filtro existente.

### SI-03.10 — Endpoint GET /videos/:id/upload/parts (retomada)
- **Status:** completed
- **Tests:** 29 passing (video-upload.service spec + integration, inclui 2 de integração novos) + videos-upload-parts.e2e-spec 4/4; regressão e2e 65/65; tsc ok
- **Observations:** 
- Validação `pending_upload`/`upload_id` extraída para o helper privado `requirePendingUploadId(video)`, usado por `signPartUrls` (SI-03.9) e `listUploadedParts`; comportamento inalterado.
  - Se o multipart já foi abortado no storage (`MultipartUploadNotFoundError`) com a linha ainda `pending_upload`, a rota devolve 500 — o Error Catalog não tem código para esse caso nesta rota.

### SI-03.11 — Endpoint POST /videos/:id/upload/complete (conclusão e enfileiramento)
- **Status:** completed
- **Tests:** 46 passing (video-upload.service spec/integration, videos.module.spec; 14 unit + 1 integração novos) + videos-upload-complete.e2e-spec 4/4; regressão e2e 69/69; tsc ok
- **Observations:** 
- Isolamento de fila nos testes: prefixo BullMQ `test-<uuid>` (e2e via `overrideProvider(getQueueToken(...))`, integração via `registerQueue({ prefix })`), com `obliterate` no fim; nenhuma chave de teste fica no Redis.
  - A fila de dev `bull:video-processing` tem 6 jobs `process-video` **failed** antigos da tentativa anterior com MinIO (Oct 22/30); jobs failed não são reprocessados por um novo processor, mas podem ser limpos.
  - Corrida entre dois `complete` simultâneos: o segundo pode receber 400 `UPLOAD_INCOMPLETE` (NoSuchUpload, conforme Error Catalog) em vez de 409; repetição sequencial recebe 409.
  - Se `queue.add` falhar depois do commit, a requisição devolve 500 e o vídeo fica em `processing` sem job — cenário não coberto pelo plano (TD-07 aceita esse risco).
  - `MAX_UPLOAD_PARTS = 10000` em `upload-limits.ts`.

### SI-03.12 — Wrapper tipado de ffprobe e ffmpeg
- **Status:** completed
- **Tests:** 27 passing (ffmpeg.service.spec 22, ffmpeg.service.integration-spec 5); regressão storage-compat + worker.module 15/15; tsc ok
- **Observations:** 
- **Classificação de falhas do ffprobe:** ele sai com código 1 tanto para mídia inválida quanto para URL inacessível. Regra: código numérico sem padrão de rede no stderr → `InvalidMediaError` (não retentável); padrões de rede (`Server returned`, `Connection refused`, `Failed to resolve hostname`, `Input/output error`…), timeout ou erro de spawn → `MediaToolError` (retentável). Coerente com "ffprobe non-zero on a reachable object → bad media".
  - `InvalidMediaError` também quando o stream de vídeo não tem codec/dimensões, sem duração ou sem `format_name`; JSON inválido → `MediaToolError`; toda falha de `extractFrame` → `MediaToolError`.
  - `ProbeResult.bitrate` é `number | null` (ffprobe pode devolver `N/A`; coluna é nullable). `containerFormat` = `format_name` cru (ex.: `mov,mp4,m4a,3gp,3g2,mj2`).
  - `FfmpegService` registrado em `VideoProcessingModule` sem exportar; `index.ts` inalterado.
  - `src/test/video-fixture.ts` ganhou opção `withAudio` (default `true`) para gerar vídeo sem áudio.

### SI-03.13 — Processor process-video (metadados, thumbnail e status final)
- **Status:** completed
- **Tests:** 56 passing (processor unit 15 + integração 6, worker.module 6, ffmpeg e videos.module); tsc ok
- **Observations:** 
- **Lacuna do plano:** `forFeature([Video])` sozinho derrubava o worker (`Entity metadata for Video#channel was not found`, pois `autoLoadEntities` só conhece entidades registradas). `VideoProcessingModule` passou a importar `UsersModule` (que traz `ChannelsModule`), mantendo cada entidade registrada pelo módulo dono; efeito colateral: `UsersService`/`ChannelsService` são instanciados no worker.
  - `VideoProcessingModule` chama `BullModule.registerQueue('video-processing')` (não listado na ação 5) para permitir isolar o prefixo do worker nos testes via `getQueueToken`; em produção usa o prefixo padrão.
  - `worker.module.integration-spec.ts` (SI-03.7) ajustado para não subir um worker na fila real de dev (fila sobrescrita com prefixo de teste; probe de conexão em fila separada `worker-module-probe`); usa um deep import com `eslint-disable-next-line` comentado.
  - `compose.yaml`: `stop_grace_period: 3m` no `video-worker` (timeouts de 60 s + 120 s do ffprobe/ffmpeg); worker recriado e rodando com o processor.
  - AC "API nunca processa jobs" garantido estruturalmente (processor só em `VideoProcessingModule`, importado só pelo `WorkerModule`, + regra de lint); sem teste dedicado no AppModule.
  - Fora de escopo: mensagens de erro do `FfmpegService` incluem a URL pré-assinada completa (válida por até 1h) e o processor as loga — vale redigir a query string em tarefa separada.

### SI-03.14 — Varredura horária de uploads abandonados
- **Status:** completed
- **Tests:** 63 passing (src/video-processing + worker.module; sweep processor 6 + scheduler 1 novos); tsc ok
- **Observations:** 
- Scheduler registrado por `StaleUploadSweepScheduler.onApplicationBootstrap` (`upsertJobScheduler`, idempotente); o `video-worker` de dev já registrou o scheduler real e completou a primeira varredura.
  - Escolha não especificada no plano: falha de abort diferente de NoSuchUpload é logada e a linha é pulada (fica `pending_upload` para a próxima rodada; lifecycle de 2 dias como backstop).
  - Guard de status no update evita sobrescrever um `complete` concorrente.
  - `video-processing.processor.integration-spec.ts` e `worker.module.integration-spec.ts` também isolam a fila `video-maintenance` com prefixo de teste.
  - Efeito colateral aceito: o scheduler isolado do `worker.module.integration-spec` dispara uma varredura contra o banco de dev compartilhado (mesmo que o worker real faz a cada boot). Flakiness teórica se a varredura horária real coincidir com a suíte do processor (janela de milissegundos).

### SI-03.15 — Endpoint GET /videos/:slug (detalhe e status)
- **Status:** completed
- **Tests:** 16 passing (video.presenter.spec 5, parse-video-slug.pipe.spec 7, slug util, videos.module) + videos-detail.e2e-spec 5/5; regressão e2e 74/74; tsc ok
- **Observations:** 
- Formato do slug validado por `ParseVideoSlugPipe` (novo), que lança `VideoNotFoundException` → 404 antes de consultar o banco; reutilizável em stream/download. `video-slug.util.ts` ganhou `isVideoSlug`.
  - Rota `GET /videos/:slug` não colide com `GET /videos/:id/upload/parts` (2 vs 4 segmentos), confirmado pela regressão e2e.
  - E2E guarda thumbnails de teste no bucket de dev em `test-e2e/videos-detail/<uuid>/` e remove no `afterEach`.

### SI-03.16 — Endpoint GET /videos/:slug/stream (reprodução via streaming)
- **Status:** completed
- **Tests:** 7 passing (video-delivery.service.spec 5, videos.module.spec) + videos-stream.e2e-spec 3/3; regressão e2e 77/77; tsc ok
- **Observations:** 
- Redirect implementado com `@Res({ passthrough: true })` + `res.location()` + `@HttpCode(302)` em vez de `@Redirect()`/`res.redirect()`, porque o Express escreve um corpo "Found. Redirecting to …" e o AC/spec exigem corpo vazio. Status/headers seguem o TD-15.
  - `VideoDeliveryService.streamUrl` criado; `downloadUrl` fica para o SI-03.17.

### SI-03.17 — Endpoint GET /videos/:slug/download
- **Status:** completed
- **Tests:** 15 passing (video-delivery.service.spec, videos.module.spec) + videos-download.e2e-spec 4/4; regressão e2e 81/81; tsc ok
- **Observations:** 
- `Content-Disposition` montado por `buildAttachmentDisposition`: fallback ASCII troca não-ASCII, `"` e `\` por `_`; parte RFC 5987 usa `encodeURIComponent` + escape de `' ( ) *`.
  - Checagem dono + `ready` extraída para o helper privado `findReadyOwned`, usado por `streamUrl` (SI-03.16) e `downloadUrl`; comportamento do stream inalterado.

### SI-03.18 — Contrato OpenAPI e documentação do fluxo de upload
- **Status:** completed
- **Tests:** swagger.e2e-spec 8/8 (2 novos); openapi-export.integration-spec 9/9; regressão e2e 83/83; re-export sem diff; tsc ok
- **Observations:** 
- `test/swagger.e2e-spec.ts` passou a gerar o documento com `buildSwaggerDocument(app)` (mesma chamada do `main.ts`/export); antes usava `createDocument` sem `extraModels` e nunca poderia igualar o arquivo.
  - `api.http` ganhou as requisições 10–17 (fluxo completo, com captura de id/slug/URL/ETag e comando ffmpeg para gerar `sample.mp4`).
  - `CLAUDE.md`: serviços `mailpit`, `redis`, `rustfs`, `video-worker`, checagens de prontidão, logs do worker, `S3_HOST_PORT`/`S3_PUBLIC_ENDPOINT`.
  - **Lacuna herdada da Fase 01 (precisa de decisão):** `openapi:export` roda via ts-node, então o plugin CLI do `@nestjs/swagger` (openapi-docs-nestjs/TD-01) não executa e `src/metadata.ts` é um stub vazio. Resultado: todos os DTOs de request (`CreateVideoDto`, `RequestPartUrlsDto`, `CompleteUploadDto`, `RegisterDto`, `LoginDto`…) saem com `properties: {}` no `openapi.json`, e alguns parâmetros (ex.: `token` do confirm-email) faltam. O e2e compara sob ts-jest (também sem plugin), por isso passa; contra um `start:dev` real o documento servido difere do versionado. Já existia antes desta fase. Correção possível: exportar a partir do `dist/` compilado com plugin ou gerar `metadata.ts` com `PluginMetadataGenerator` — muda o mecanismo da Fase 01, fica para tarefa separada.

## Final verification

- Unit + integration (`npm test -- --runInBand`): 46 suítes, 332/332 passing
- E2E (`npm run test:e2e`): 10 suítes, 83/83 passing — o script não tinha `--runInBand` (pré-existente, apesar de o CLAUDE.md dizer "already configured"); em paralelo as suítes de vídeo disputavam banco/bucket e falhavam. Adicionado `--runInBand` ao script.
- `npx tsc --noEmit`: exit 0
- Lint: 0 erros, 0 avisos — a dívida de 150 erros da Fase 02 foi corrigida na branch `bugfix/lint-debt` (merge em `main`) e esta branch foi rebaseada sobre ela. Suítes reexecutadas após o rebase: 332/332 e 83/83.

## Correções pós-implementação (antes do merge)

- `de23a00` — mensagens de erro do ffprobe/ffmpeg passam a trazer a URL sem query string (sem assinatura/credencial nos logs do worker). O `cause` (erro cru do `execFile`) ainda contém a URL completa, mas nada o registra hoje.
- `e2c908c` — worker compila em `dist-worker/` (`tsconfig.worker.json`); `start:dev`/`nest build` da API não derrubam mais o worker.
- `cd04363` — resolve a lacuna do SI-03.18: `openapi:export` gera `src/metadata.ts` (plugin do Swagger via `PluginMetadataGenerator`) e `buildSwaggerDocument` carrega o metadata; `openapi.json`, servidor compilado e e2e produzem o mesmo documento, com DTOs de request completos. `CreateVideoDto` ganhou `@ApiProperty` explícito em `mime_type` (enum) e `size_bytes` (maximum), que o plugin em modo readonly não infere. `src/metadata.ts` é versionado, protegido por teste de staleness e ignorado pelo Prettier.
- Verificação após as correções: unit+integration 346/346, e2e 84/84, `tsc` ok, lint 0 erros.
