---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-30T03:22:40-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-30T03:21:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-30T03:20:54-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-22T11:01:47-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB direto para o object storage sem impacto na API, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano via fila (extração de duração e metadados e geração de thumbnail a partir de um frame), URL única por vídeo sem conflito, reprodução via streaming e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: Redis, RustFS e FFmpeg no ambiente Docker

**Description:** Sobe a infraestrutura que a fase inteira usa: Redis para a fila, RustFS como object storage local e os binários `ffmpeg`/`ffprobe` na imagem de desenvolvimento.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `redis` (imagem `redis` com tag fixa de versão, healthcheck `redis-cli ping`, sem porta publicada) (per `phase-03-videos/TD-01`)
2. Adicionar ao `nestjs-project/compose.yaml` o serviço `rustfs` com a imagem `rustfs/rustfs:1.0.4`, porta `9000` publicada (o navegador envia as partes direto para ela), volume nomeado para os dados, credenciais via env e healthcheck; incluir `redis` e `rustfs` em `depends_on` de `nestjs-api` com `condition: service_healthy` (per `phase-03-videos/TD-02`)
3. Alterar `nestjs-project/Dockerfile.dev` para instalar o pacote `ffmpeg` da distribuição no mesmo `apt install` (per `phase-03-videos/TD-11`)
4. Acrescentar a `nestjs-project/.env.example` os blocos `# Queue (Redis)` com `REDIS_HOST=redis`, `REDIS_PORT=6379` e `# Object storage (RustFS)` com `S3_ENDPOINT=http://rustfs:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET=streamtube-videos`, `S3_CORS_ALLOWED_ORIGINS`; comentar que `S3_PUBLIC_ENDPOINT` é o único host visto pelo navegador da máquina host e por isso usa `localhost`, enquanto todo acesso entre containers usa o nome do serviço (per `phase-03-videos/TD-04`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `redis` e `rustfs` como `healthy` depois de `docker compose up -d`
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` terminam com código 0
- `docker compose exec nestjs-api curl -s -o /dev/null -w '%{http_code}' http://rustfs:9000/health` (ou o endpoint de saúde documentado pelo RustFS) responde `200`

---

### SI-03.2 — Infra: dependências e namespaces de configuração de storage e fila

**Description:** Instala as bibliotecas decididas e cria as configurações `storage` e `queue` no padrão `registerAs` + Joi herdado da Fase 01.

**Technical actions:**

1. Instalar dentro do container `bullmq@^6.5.1`, `@nestjs/bullmq@^11.0.5`, `@aws-sdk/client-s3@^3.1160.0` e `@aws-sdk/s3-request-presigner@^3.1160.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `endpoint`, `publicEndpoint`, `region`, `accessKeyId`, `secretAccessKey`, `bucket`, `corsAllowedOrigins` (lista separada por vírgula) (per `phase-03-videos/TD-04`, inherited `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` com `host` e `port` do Redis (per `phase-03-videos/TD-01`)
4. Estender `src/config/env.validation.ts` com `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `S3_ENDPOINT` e `S3_PUBLIC_ENDPOINT` (`uri`, obrigatórios), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` (obrigatórios), `S3_CORS_ALLOWED_ORIGINS` (default `*`); registrar os dois namespaces no `load` de `ConfigModule.forRoot` em `AppModule` e preencher o `.env` local com os valores de `.env.example` de SI-03.1 (per inherited `phase-01-configuracao-base/TD-02`)
5. Criar `src/test/setup-test-env.ts`, que define `process.env.S3_PUBLIC_ENDPOINT = 'http://rustfs:9000'`, e colocá-lo **antes** de `dotenv/config` em `setupFiles` no `package.json` (`<rootDir>/test/setup-test-env.ts`) e em `test/jest-e2e.json` (`<rootDir>/src/test/setup-test-env.ts`); como o `dotenv` não sobrescreve variáveis já definidas, os testes assinam URLs com o host que o container alcança, enquanto o dev continua com `localhost:9000` para o navegador (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Unit: rejeita ausência de `S3_ENDPOINT`/`S3_BUCKET`, aplica defaults de `REDIS_HOST`/`REDIS_PORT`/`S3_REGION` | `src/config/env.validation.spec.ts` |

**Dependencies:** SI-03.1 — os defaults apontam para os serviços `redis` e `rustfs`

**Acceptance criteria:**

- A API sobe sem erro de validação de env com o `.env` preenchido
- Remover `S3_BUCKET` do ambiente faz a inicialização falhar com mensagem de validação citando `S3_BUCKET`
- `package.json` lista as quatro dependências nas faixas de versão decididas
- Dentro de uma suíte Jest (unit, integration ou e2e), `process.env.S3_PUBLIC_ENDPOINT` vale `http://rustfs:9000` mesmo com o `.env` apontando para `http://localhost:9000`

---

### SI-03.3 — Módulo de storage com clientes interno e público

**Description:** Cria o `StorageModule`, único dono do acesso ao object storage, com as operações de multipart, presign e bootstrap do bucket que as SIs seguintes usam.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois providers `S3Client` (tokens `S3_INTERNAL_CLIENT` e `S3_PUBLIC_CLIENT`) construídos a partir de `storageConfig`, ambos com `forcePathStyle: true`; o público só assina URLs, nunca faz chamadas de rede (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
2. Criar `src/storage/storage.service.ts` — `StorageService` com `createMultipartUpload(key, contentType)`, `signUploadPartUrl(key, uploadId, partNumber, expiresIn)`, `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(key)`, `putObject(key, body, contentType)`, `deleteObject(key)` e `signGetUrl(key, { expiresIn, client: 'internal' | 'public', contentDisposition? })`; traduz erros S3 conhecidos (`NoSuchUpload`, `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NotFound`) em erros tipados do próprio módulo (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`, `phase-03-videos/TD-15`)
3. Criar `src/storage/storage-bootstrap.service.ts` — em `onModuleInit`, cria o bucket se não existir, aplica `PutBucketCors` (`AllowedOrigins` de `S3_CORS_ALLOWED_ORIGINS`, métodos `PUT`/`GET`/`HEAD`, `ExposeHeaders: ['ETag']`) e `PutBucketLifecycleConfiguration` com `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 }`; idempotente a cada boot (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`)
4. Criar `src/storage/index.ts` como API pública do módulo (exporta `StorageModule`, `StorageService` e os erros tipados) e importar `StorageModule` em `AppModule` (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test com `storageConfig` de teste | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: multipart create → upload de parte via URL assinada → complete → head; abort; tradução de `NoSuchUpload`/`InvalidPart` contra o serviço `rustfs` real | `src/storage/storage.service.integration-spec.ts` |
| `StorageBootstrapService` | Integration: dois boots seguidos não falham e o bucket fica com CORS e lifecycle lidos de volta | `src/storage/storage-bootstrap.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — usa `storageConfig` e o SDK instalado

**Acceptance criteria:**

- Ao subir a API com o bucket inexistente, o bucket `S3_BUCKET` passa a existir no RustFS
- `GetBucketCors` do bucket retorna uma regra que expõe o header `ETag` e permite `PUT`
- `GetBucketLifecycleConfiguration` do bucket retorna a regra `AbortIncompleteMultipartUpload` com `DaysAfterInitiation: 2`
- Uma URL de leitura gerada com `client: 'public'` tem o host de `S3_PUBLIC_ENDPOINT`; com `client: 'internal'`, o host de `S3_ENDPOINT`
- Concluir um multipart com uma parte inexistente produz o erro tipado de parte inválida, não um erro genérico do SDK

---

### SI-03.4 — Gate de compatibilidade do storage (RustFS)

**Description:** Prova, contra o serviço `rustfs` real, cada operação S3 de que a fase depende, antes de qualquer SI de upload ou streaming ser construída sobre ela. Se algum item falhar, a fase troca para MinIO fixado sem mudar código de aplicação.

**Technical actions:**

1. Criar `src/test/video-fixture.ts` — gera um MP4 curto (por exemplo, `ffmpeg -f lavfi -i testsrc=duration=3:size=640x360 -f lavfi -i sine=duration=3 ...`) em diretório temporário e um arquivo não-vídeo de controle, sem versionar binários no repositório (per `phase-03-videos/TD-11`)
2. Criar `src/storage/storage-compat.integration-spec.ts` cobrindo, via `StorageService` e `fetch` (cliente HTTP fora do SDK): `UploadPart` por PUT em URL assinada com o `ETag` lido da resposta; `ListParts` após upload parcial; `CompleteMultipartUpload` + `HeadObject` com `ContentLength` igual ao enviado; GET com `Range: bytes=0-1023` respondendo `206`; GET assinado com `ResponseContentDisposition` devolvendo o header `Content-Disposition: attachment`; preflight `OPTIONS` com `Origin` permitido expondo `ETag`; lifecycle `AbortIncompleteMultipartUpload` lido de volta; `ffprobe` lendo uma URL assinada do objeto (per `phase-03-videos/TD-02`)
3. Se algum caso falhar mesmo após tentar `requestChecksumCalculation: 'WHEN_REQUIRED'` / `responseChecksumValidation: 'WHEN_REQUIRED'` nos clientes: trocar o serviço do Compose para MinIO com tag fixa (Option A de `phase-03-videos/TD-02`), rodar o gate de novo e registrar a troca com `/decide` antes de seguir (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Contrato S3 do storage local | Integration: as 8 verificações do gate contra o serviço real | `src/storage/storage-compat.integration-spec.ts` |

**Dependencies:** SI-03.3 — o gate exercita o `StorageService` e o bootstrap do bucket

**Acceptance criteria:**

- Um objeto enviado em duas partes por PUT em URLs assinadas e concluído pelo `ETag` de cada parte tem `HeadObject.ContentLength` igual à soma das partes
- GET com `Range: bytes=0-1023` no objeto concluído retorna `206` com `Content-Range` e exatamente 1024 bytes
- GET em URL assinada com disposição `attachment` retorna o header `Content-Disposition` começando com `attachment`
- Preflight `OPTIONS` de PUT com um `Origin` permitido retorna `Access-Control-Expose-Headers` contendo `ETag`
- `ffprobe` aponta a URL assinada do objeto e retorna JSON com um stream de vídeo
- O gate inteiro passa contra a imagem de storage que fica no `compose.yaml` ao fim desta SI

---

### SI-03.5 — Entidade Video, migration e gerador de slug

**Description:** Cria a tabela `videos` exatamente como em `### Data Model → Video` e o gerador do identificador público único.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `Video` com todos os campos, enums `video_processing_status` / `video_publication_status`, transformer `bigint`/`numeric` → `number` e `@ManyToOne(() => Channel)` em `channel_id` com `onDelete: 'CASCADE'` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-11`)
2. Criar `src/videos/video.enums.ts` — `VideoProcessingStatus`, `VideoPublicationStatus` e `VideoFailureReason` (`upload_expired`, `size_mismatch`, `invalid_media`, `processing_error`) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
3. Gerar `src/database/migrations/{timestamp}-CreateVideos.ts` com a tabela, os dois tipos enum, a FK e os índices (único em `slug`, em `channel_id`, composto em (`processing_status`, `created_at`)) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-14`)
4. Criar `src/videos/video-slug.util.ts` — `generateVideoSlug()` retornando `crypto.randomBytes(8).toString('base64url')` (11 caracteres `[A-Za-z0-9_-]`) (per `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults `pending_upload`/`draft`, unique em `slug`, FK + cascade ao apagar o canal, `bigint` lido como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateVideoSlug` | Unit: 11 caracteres no alfabeto base64url, valores distintos em chamadas seguidas | `src/videos/video-slug.util.spec.ts` |

**Dependencies:** none — depende só das entidades da Fase 02

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos`; `npm run migration:revert` a remove junto com os dois tipos enum
- Inserir um vídeo só com os campos obrigatórios grava `processing_status = 'pending_upload'` e `publication_status = 'draft'`
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade
- Apagar um canal apaga seus vídeos
- `size_bytes = 10737418240` é gravado e lido de volta como o número `10737418240`

---

### SI-03.6 — Infra: BullMQ na API e módulo de banco compartilhável

**Description:** Liga a API ao Redis como produtora de jobs e extrai a configuração do TypeORM para um módulo que o worker também possa importar, sem duplicar parâmetros de conexão.

**Technical actions:**

1. Extrair o `TypeOrmModule.forRootAsync` de `AppModule` para `src/database/database.module.ts` (mesmo `useFactory` com `databaseConfig`) e importar `DatabaseModule` em `AppModule` (per inherited convention "Database connection parameters … single `databaseConfig` factory")
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `queueConfig` (`connection: { host, port }`) e importá-lo em `AppModule` (per `phase-03-videos/TD-01`)
3. Criar `src/video-processing/video-processing.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `VIDEO_MAINTENANCE_QUEUE = 'video-maintenance'`, `EXPIRE_STALE_UPLOADS_JOB = 'expire-stale-uploads'`, o tipo `ProcessVideoJobData = { videoId: string }` e as opções de job de `### Events/Messages → process-video` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
4. Criar `src/video-processing/index.ts` exportando só as constantes e o tipo acima, como API pública do módulo (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration: compilation test conectando ao serviço `redis` real e registrando a fila `video-processing` | `src/queue/queue.module.integration-spec.ts` |
| `DatabaseModule` | Integration: compilation test conectando ao `db` | `src/database/database.module.integration-spec.ts` |

**Dependencies:** SI-03.2 — usa `queueConfig` e o pacote `@nestjs/bullmq`

**Acceptance criteria:**

- A API sobe e conecta ao Redis do serviço `redis`; parar o `redis` faz a API registrar erro de conexão em vez de seguir silenciosamente
- Toda a suíte existente da Fase 02 continua passando depois da extração do `DatabaseModule`
- `AppModule` não contém mais parâmetros de conexão de banco inline

---

### SI-03.7 — Infra: entrypoint do worker e fronteira entre módulos

**Description:** Cria o segundo processo do monólito modular (o `video-worker`), sem HTTP, e uma regra de lint que impede imports profundos entre `videos`, `storage` e `video-processing`.

**Technical actions:**

1. Criar `src/video-processing/video-processing.module.ts` (ainda sem processors) e `src/worker.module.ts` importando `ConfigModule.forRoot` (mesmo `load` e `validationSchema` de `AppModule`), `DatabaseModule`, `QueueModule`, `StorageModule` e `VideoProcessingModule` (per `phase-03-videos/TD-10`)
2. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()` para fechar os workers BullMQ no `SIGTERM` (per `phase-03-videos/TD-10`)
3. Adicionar ao `package.json` os scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`) (per `phase-03-videos/TD-10`)
4. Adicionar ao `compose.yaml` o serviço `video-worker` com o mesmo `build` e volume de `nestjs-api`, `command: npm run start:worker:dev` e `depends_on` em `db`, `redis` e `rustfs` (`service_healthy`) (per `phase-03-videos/TD-10`)
5. Adicionar ao `eslint.config.mjs` uma regra `no-restricted-imports` com padrões que proíbem importar `**/storage/*` e `**/video-processing/*` de fora do próprio módulo, exceto o `index.ts` (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Integration: compilation test criando o application context com `db`, `redis` e `rustfs` reais e fechando sem handles abertos | `src/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.3 (`StorageModule`), SI-03.6 (`DatabaseModule`, `QueueModule`)

**Acceptance criteria:**

- `docker compose up -d video-worker` deixa o serviço `running` e os logs mostram o contexto Nest inicializado, sem servidor HTTP escutando
- `docker compose stop video-worker` encerra o processo de forma limpa, sem reinício forçado por timeout
- Um arquivo de `src/videos/` que importa `../storage/storage.service` faz `npm run lint` falhar; importar de `../storage` passa

---

### SI-03.8 — Endpoint POST /videos (pré-cadastro do rascunho e início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (per `### Authorization Matrix`)

**Description:** Ao iniciar o upload, cria o vídeo como rascunho no canal do usuário e abre o multipart no storage, devolvendo o tamanho e a quantidade de partes que o cliente deve enviar.

**Technical actions:**

1. Criar `src/videos/upload-limits.ts` (10 GiB, 64 MiB, 3600 s, lista de MIME) e os DTOs `CreateVideoDto`, `VideoResponseDto` e `CreatedVideoResponseDto` com os campos e regras de `### API Contracts → POST /videos` e `#### Validation Rules — Upload` (per `phase-03-videos/TD-06`)
2. Adicionar `findByUserId(userId)` em `ChannelsService` e exportar `ChannelsService` de `ChannelsModule`, para que `videos` resolva o canal sem acessar o repositório de `Channel` (Single Responsibility do `CLAUDE.md`: o módulo `channels` é dono da entidade `Channel`)
3. Criar `src/videos/video-upload.service.ts` — `VideoUploadService.initiate(userId, dto)`: gera `id` com `crypto.randomUUID()`, chama `createMultipartUpload('videos/{id}/original', mime_type)`, insere o `Video` com `upload_id`, `original_key`, `declared_size_bytes` e `title` padrão; em violação de unicidade de `slug`, gera outro e tenta de novo (até 5 vezes); se o insert falhar de vez, chama `abortMultipartUpload` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`, `phase-03-videos/TD-14`)
4. Criar `src/videos/video.presenter.ts` — `VideoPresenter.toResponse(video)` monta `VideoResponse`, incluindo `thumbnail_url` assinada no cliente público quando `thumbnail_key` existe (per `phase-03-videos/TD-15`)
5. Criar `src/videos/videos.controller.ts` com `@Post()` retornando `201` e `src/videos/videos.module.ts` (importa `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`); registrar `VideosModule` em `AppModule` e anotar o controller para o Swagger (per `phase-03-videos/TD-10`, inherited `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.initiate` | Unit: retry de `slug` em violação de unicidade, abort do multipart quando o insert falha, `title` padrão sem extensão (mock de repo e `StorageService`) | `src/videos/video-upload.service.spec.ts` |
| `VideoUploadService.initiate` | Integration: grava o `Video` com `upload_id` e `original_key` e o multipart existe no `rustfs` | `src/videos/video-upload.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4 (gate do storage aprovado), SI-03.5 (entidade `Video`), SI-03.6 (fila registrada)

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 200000000 }` retorna `201` com `processing_status: "pending_upload"`, `publication_status: "draft"`, `title: "aula"`, `slug` de 11 caracteres e `upload: { part_size_bytes: 67108864, part_count: 3 }`
- Depois desse `201`, existe uma linha em `videos` no canal do usuário autenticado, com `upload_id` preenchido
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `mime_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`

---

### SI-03.9 — Endpoint POST /videos/:id/upload/part-urls

**Route:** POST /videos/:id/upload/part-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-part-urls.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Assina as URLs de `UploadPart` que o cliente usa para enviar as partes direto ao storage, no início e de novo ao retomar, e introduz a busca de vídeo com checagem de dono que as rotas seguintes reusam.

**Technical actions:**

1. Criar `src/videos/video.exceptions.ts` com as subclasses de `DomainException` de `### Error Catalog`: `VideoNotFoundException`, `VideoUploadNotPendingException`, `InvalidPartNumberException`, `UploadIncompleteException`, `UploadSizeMismatchException`, `VideoNotReadyException` (per inherited `phase-02-auth/TD-07`)
2. Criar `src/videos/videos.service.ts` — `VideosService.findOwnedById(id, userId)` e `findOwnedBySlug(slug, userId)`, que fazem join com o canal do usuário e lançam `VideoNotFoundException` tanto para vídeo inexistente quanto de outro canal (per `phase-03-videos/TD-16`)
3. Adicionar `VideoUploadService.signPartUrls(id, userId, partNumbers)`: exige `pending_upload` (senão `VideoUploadNotPendingException`), rejeita número acima de `ceil(declared_size_bytes / part_size)` com `InvalidPartNumberException` e assina cada parte no cliente público com TTL de 3600 s (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
4. Criar `RequestPartUrlsDto` e `PartUrlsResponseDto` conforme `### API Contracts → POST /videos/:id/upload/part-urls` e expor a rota no `VideosController` com `ParseUUIDPipe` em `:id`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.signPartUrls` | Unit: status diferente de `pending_upload`, número de parte fora do intervalo, `expires_at` = agora + 1h | `src/videos/video-upload.service.spec.ts` |
| `VideosService` | Integration: `findOwnedById`/`findOwnedBySlug` devolvem o vídeo do dono e lançam not-found para outro canal | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — usa `VideoUploadService`, `VideosController` e o vídeo criado por `POST /videos`

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com `{ part_numbers: [1, 2] }` para um vídeo próprio em `pending_upload` retorna `200` com duas URLs no host de `S3_PUBLIC_ENDPOINT` e `expires_at` cerca de 1h no futuro
- Um PUT dos bytes da parte 1 na URL devolvida responde `200` com header `ETag`
- A mesma chamada com `part_numbers: [999]` para um vídeo de 3 partes retorna `400` com `error: "INVALID_PART_NUMBER"`
- A mesma chamada feita por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- A mesma chamada para um vídeo em `processing` retorna `409` com `error: "VIDEO_UPLOAD_NOT_PENDING"`
- `:id` que não é uuid retorna `400`

---

### SI-03.10 — Endpoint GET /videos/:id/upload/parts (retomada)

**Route:** GET /videos/:id/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Lista as partes já gravadas no multipart aberto, para o cliente retomar um upload interrompido enviando só o que falta.

**Technical actions:**

1. Adicionar `VideoUploadService.listUploadedParts(id, userId)`: exige `pending_upload`, chama `StorageService.listParts` paginando até o fim e devolve `{ part_number, etag, size_bytes }` ordenado por `part_number` (per `phase-03-videos/TD-05`)
2. Criar `UploadedPartsResponseDto` e expor a rota no `VideosController` com `ParseUUIDPipe` em `:id`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.listUploadedParts` | Integration: depois de enviar 2 de 3 partes no `rustfs`, devolve exatamente as partes 1 e 2 com seus `ETag` | `src/videos/video-upload.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — reusa `findOwnedById` e precisa das URLs de parte para enviar bytes

**Acceptance criteria:**

- Depois de enviar as partes 1 e 2 de um vídeo de 3 partes, `GET /videos/:id/upload/parts` retorna `200` com `parts` contendo `part_number` 1 e 2, cada um com o `ETag` devolvido no PUT
- Para um vídeo recém-criado sem partes enviadas, a rota retorna `200` com `parts: []`
- Para um vídeo de outro usuário, a rota retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Para um vídeo já em `processing`, a rota retorna `409` com `error: "VIDEO_UPLOAD_NOT_PENDING"`

---

### SI-03.11 — Endpoint POST /videos/:id/upload/complete (conclusão e enfileiramento)

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Conclui o multipart, confere o tamanho gravado, muda o vídeo para `processing` e só depois do commit publica o job `process-video`, disparando o processamento automático.

**Technical actions:**

1. Adicionar `VideoUploadService.complete(id, userId, parts)`: exige `pending_upload`; chama `completeMultipartUpload` e traduz parte inválida/ausente em `UploadIncompleteException` mantendo o multipart aberto (per `phase-03-videos/TD-07`)
2. No mesmo método, chamar `headObject`; se `ContentLength` ≠ `declared_size_bytes` ou > 10 GiB, apagar o objeto, gravar `failed` + `failure_reason = size_mismatch` + `upload_id = null` e lançar `UploadSizeMismatchException` (per `phase-03-videos/TD-06`)
3. Com o tamanho aceito, atualizar numa transação `size_bytes`, `upload_id = null` e `processing_status = processing` com `WHERE processing_status = 'pending_upload'` (dois `complete` simultâneos: só um muda a linha, o outro recebe `VideoUploadNotPendingException`); depois do commit, `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId, ...opções de Events/Messages })` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
4. Criar `CompleteUploadDto` e `CompletedPartDto` conforme `### API Contracts → POST /videos/:id/upload/complete` e expor a rota no `VideosController` retornando `200`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.complete` | Unit: parte inválida → `UploadIncompleteException` sem mudar status; tamanho divergente → `failed`/`size_mismatch` e objeto apagado; enfileira só depois do commit (mock de repo, storage e fila) | `src/videos/video-upload.service.spec.ts` |
| `VideoUploadService.complete` | Integration: upload real no `rustfs` → linha em `processing` com `size_bytes` e job `process-video` com `jobId = videoId` no Redis | `src/videos/video-upload.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — o fluxo de complete pressupõe partes enviadas pelas URLs de SI-03.9 e listáveis

**Acceptance criteria:**

- Depois de enviar todas as partes, `POST /videos/:id/upload/complete` com os pares `part_number`/`etag` retorna `200` com `processing_status: "processing"` e `size_bytes` igual ao tamanho declarado
- Após esse `200`, a fila `video-processing` tem um job `process-video` com id igual ao `id` do vídeo e payload `{ "videoId": "<id>" }`
- Repetir o mesmo `complete` retorna `409` com `error: "VIDEO_UPLOAD_NOT_PENDING"` e não cria um segundo job
- Um `complete` com um `etag` errado retorna `400` com `error: "UPLOAD_INCOMPLETE"` e o vídeo continua em `pending_upload`, aceitando um novo `complete` corrigido
- Um upload cujo tamanho real difere do declarado retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`; o vídeo fica `failed` com `failure_reason: "size_mismatch"` e o objeto não existe mais no storage

---

### SI-03.12 — Wrapper tipado de ffprobe e ffmpeg

**Description:** Encapsula os dois únicos comandos de mídia da fase (sondagem de metadados e extração de um frame) num serviço tipado sobre `execFile`, sem `fluent-ffmpeg`.

**Technical actions:**

1. Criar `src/video-processing/ffmpeg/ffmpeg.service.ts` — `FfmpegService.probe(inputUrl)`: `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputUrl])` com timeout, mapeando o JSON para `ProbeResult { durationSeconds, width, height, videoCodec, audioCodec | null, containerFormat, bitrate }` a partir do primeiro stream de vídeo e do primeiro de áudio (per `phase-03-videos/TD-11`, `phase-03-videos/TD-12`)
2. Em `probe`, lançar `InvalidMediaError` quando o ffprobe sai com código ≠ 0 por mídia ilegível ou quando não há stream de vídeo; erros de rede/timeout viram `MediaToolError` (recuperável) (per `phase-03-videos/TD-09`)
3. Adicionar `FfmpegService.extractFrame(inputUrl, atSeconds, outputPath)`: `-ss` antes de `-i` (seek por range), `-frames:v 1`, `-vf scale=1280:-2`, saída JPEG; e a função pura `thumbnailTimestamp(durationSeconds)` = 10% da duração, 0 para durações menores que 1 s (per `phase-03-videos/TD-13`)
4. Registrar `FfmpegService` como provider de `VideoProcessingModule` (não exportado — só o worker usa) (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` / `thumbnailTimestamp` | Unit: mapeamento do JSON do ffprobe (com e sem áudio), classificação `InvalidMediaError` vs `MediaToolError`, regra de 10% e de clipes curtos (mock de `execFile`) | `src/video-processing/ffmpeg/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: `probe` e `extractFrame` com os binários reais sobre a fixture de SI-03.4 servida por URL assinada do `rustfs` | `src/video-processing/ffmpeg/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (fixture de vídeo e ffmpeg lendo URL assinada já comprovados), SI-03.7 (`VideoProcessingModule`)

**Acceptance criteria:**

- `probe` na fixture de 3 s 640x360 com áudio retorna `durationSeconds` ≈ 3, `width` 640, `height` 360, `videoCodec` e `audioCodec` não nulos
- `probe` numa fixture sem trilha de áudio retorna `audioCodec: null`
- `probe` no arquivo de controle não-vídeo lança `InvalidMediaError`
- `extractFrame` gera um JPEG de 1280 px de largura com a proporção da fonte preservada
- `thumbnailTimestamp(120)` é `12` e `thumbnailTimestamp(0.5)` é `0`

---

### SI-03.13 — Processor process-video (metadados, thumbnail e status final)

**Description:** Consome `process-video` no worker: extrai duração e metadados, gera e grava a thumbnail e deixa o vídeo `ready` ou `failed` com o motivo, conforme `### Events/Messages → process-video`.

**Technical actions:**

1. Criar `src/video-processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE) VideoProcessingProcessor extends WorkerHost`; em `process(job)`, carregar o vídeo e retornar sem fazer nada se o status não for `processing` (per `phase-03-videos/TD-07`)
2. Assinar uma URL GET com o cliente **interno** para `original_key`, chamar `FfmpegService.probe`, extrair o frame para um arquivo temporário, gravar com `putObject('videos/{id}/thumbnail.jpg', ..., 'image/jpeg')` e apagar o temporário no `finally` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
3. Persistir num único update `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container_format`, `bitrate`, `thumbnail_key`, `processed_at` e `processing_status = ready` (per `phase-03-videos/TD-11`)
4. Converter `InvalidMediaError` em `UnrecoverableError`; tratar falha terminal (unrecoverable, ou última tentativa: `job.attemptsMade + 1 >= job.opts.attempts`) gravando `failed` com `invalid_media` ou `processing_error` antes de relançar (per `phase-03-videos/TD-09`)
5. Registrar o processor e `TypeOrmModule.forFeature([Video])` em `VideoProcessingModule`, garantindo que o processor só entra no grafo de `WorkerModule`, nunca no de `AppModule` (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: status ≠ `processing` vira no-op; `InvalidMediaError` → `UnrecoverableError` + `invalid_media`; erro comum antes da última tentativa só relança; na última grava `processing_error` (mock de repo, storage e ffmpeg) | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration: com `db`, `rustfs` e ffmpeg reais, `process()` sobre a fixture enviada deixa a linha `ready` com metadados e a thumbnail existe no bucket | `src/video-processing/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.11 (o job é produzido no complete), SI-03.12 (`FfmpegService`)

**Acceptance criteria:**

- Com `video-worker` rodando, concluir o upload de um MP4 válido leva o vídeo a `processing_status: "ready"` com `duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `bitrate` e `processed_at` preenchidos
- Depois desse processamento, existe o objeto `videos/{id}/thumbnail.jpg` no bucket, um JPEG de 1280 px de largura
- Concluir o upload de um arquivo que não é vídeo leva a `processing_status: "failed"` com `failure_reason: "invalid_media"` sem nova tentativa
- Com o storage inacessível durante as 3 tentativas, o vídeo termina `failed` com `failure_reason: "processing_error"`
- Entregar duas vezes o job de um vídeo já `ready` não altera a linha nem a thumbnail
- A API sem o `video-worker` rodando nunca processa o job: o vídeo fica em `processing` até o worker subir

---

### SI-03.14 — Varredura horária de uploads abandonados

**Description:** Marca como `failed` (`upload_expired`) os vídeos que ficaram em `pending_upload` por mais de 24h e aborta o multipart deles, conforme `### Events/Messages → expire-stale-uploads`.

**Technical actions:**

1. Criar `src/video-processing/stale-upload-sweep.processor.ts` — `@Processor(VIDEO_MAINTENANCE_QUEUE) StaleUploadSweepProcessor`: seleciona `pending_upload` com `created_at < now() - interval '24 hours'`, chama `abortMultipartUpload` para cada `upload_id` ignorando o erro tipado de upload inexistente, e grava `failed`, `failure_reason = upload_expired`, `upload_id = null` com `WHERE processing_status = 'pending_upload'` (um `complete` concorrente vence) (per `phase-03-videos/TD-08`)
2. Criar `src/video-processing/stale-upload-sweep.scheduler.ts` — em `onApplicationBootstrap`, `queue.upsertJobScheduler(EXPIRE_STALE_UPLOADS_JOB, { every: 3600000 }, { name: EXPIRE_STALE_UPLOADS_JOB })` (per `phase-03-videos/TD-08`)
3. Registrar a fila `video-maintenance`, o processor e o scheduler em `VideoProcessingModule` (grafo do worker) (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StaleUploadSweepProcessor` | Integration: com vídeos de 25h e de 1h em `pending_upload` e um de 25h já `ready`, só o primeiro vira `failed`/`upload_expired` e seu multipart deixa de existir no `rustfs` | `src/video-processing/stale-upload-sweep.processor.integration-spec.ts` |
| `StaleUploadSweepScheduler` | Integration: dois boots seguidos deixam exatamente um job scheduler `expire-stale-uploads` com intervalo de 1h no Redis | `src/video-processing/stale-upload-sweep.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.7 (worker), SI-03.8 (vídeos em `pending_upload` com `upload_id`)

**Acceptance criteria:**

- Um vídeo em `pending_upload` criado há 25h passa a `processing_status: "failed"` com `failure_reason: "upload_expired"` e `upload_id` nulo após uma execução da varredura
- Depois disso, `ListParts` para o antigo `upload_id` falha com upload inexistente
- Um vídeo em `pending_upload` criado há 1h não é alterado
- Rodar a varredura duas vezes seguidas não altera nenhuma linha na segunda execução
- Reiniciar o `video-worker` não cria um segundo agendamento

---

### SI-03.15 — Endpoint GET /videos/:slug (detalhe e status)

**Route:** GET /videos/:slug
**Test Specs:** see `nestjs-project/specs/videos-detail.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Expõe ao dono o vídeo pela sua URL única, com o status de processamento, os metadados e a thumbnail quando prontos.

**Technical actions:**

1. Expor `@Get(':slug')` no `VideosController` chamando `VideosService.findOwnedBySlug` e `VideoPresenter.toResponse`; validar o formato do slug (11 caracteres base64url) antes de consultar, respondendo `404` para formatos inválidos (per `phase-03-videos/TD-14`, `phase-03-videos/TD-16`)
2. Anotar a rota para o Swagger com `VideoResponseDto` e a resposta `404` usando o envelope de erro existente (per inherited `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoPresenter` | Unit: `thumbnail_url` nula sem `thumbnail_key` e assinada no host público com ela; datas em ISO-8601 | `src/videos/video.presenter.spec.ts` |

**Dependencies:** SI-03.9 (`findOwnedBySlug`), SI-03.13 (vídeos `ready` com thumbnail para o caso completo)

**Acceptance criteria:**

- `GET /videos/:slug` do dono para um vídeo `ready` retorna `200` com `processing_status: "ready"`, metadados preenchidos e `thumbnail_url` no host de `S3_PUBLIC_ENDPOINT` que responde `200` com `Content-Type: image/jpeg`
- Para um vídeo em `pending_upload`, a rota retorna `200` com metadados nulos e `thumbnail_url: null`
- Para um vídeo `failed`, a rota retorna `200` com `failure_reason` preenchido
- Outro usuário recebe `404` com `error: "VIDEO_NOT_FOUND"` para o mesmo slug
- Um slug inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.16 — Endpoint GET /videos/:slug/stream (reprodução via streaming)

**Route:** GET /videos/:slug/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Autoriza o dono e redireciona para uma URL assinada do storage, que atende `Range` com `206`, permitindo reproduzir sem baixar o arquivo inteiro e sem passar bytes de vídeo pela API.

**Technical actions:**

1. Criar `src/videos/video-delivery.service.ts` — `VideoDeliveryService.streamUrl(slug, userId)`: `findOwnedBySlug`, exige `ready` (senão `VideoNotReadyException`) e assina GET de `original_key` no cliente público com TTL de 3600 s (per `phase-03-videos/TD-15`, `phase-03-videos/TD-16`)
2. Expor `@Get(':slug/stream')` no `VideosController` respondendo `302` com `Location` e `Cache-Control: no-store`; documentar no Swagger a resposta `302` (per `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService` | Unit: status ≠ `ready` → `VideoNotReadyException`; URL assinada com cliente público e TTL de 1h (mock de `VideosService` e `StorageService`) | `src/videos/video-delivery.service.spec.ts` |

**Dependencies:** SI-03.13 (vídeos `ready`), SI-03.15 (`VideosController` com as rotas por slug)

**Acceptance criteria:**

- `GET /videos/:slug/stream` do dono para um vídeo `ready` retorna `302` com `Location` no host de `S3_PUBLIC_ENDPOINT` e `Cache-Control: no-store`
- Um GET na `Location` com `Range: bytes=0-1023` retorna `206` com 1024 bytes
- Para um vídeo em `processing`, a rota retorna `409` com `error: "VIDEO_NOT_READY"`
- Outro usuário recebe `404` com `error: "VIDEO_NOT_FOUND"`
- A resposta da API não contém bytes do vídeo (corpo vazio no `302`)

---

### SI-03.17 — Endpoint GET /videos/:slug/download

**Route:** GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Igual ao streaming, mas a URL assinada força o navegador a salvar o arquivo com o nome original.

**Technical actions:**

1. Adicionar `VideoDeliveryService.downloadUrl(slug, userId)`: mesmas regras de `streamUrl`, assinando com `ResponseContentDisposition` = `attachment; filename="{nome ASCII seguro}"; filename*=UTF-8''{nome codificado em RFC 5987}` a partir de `original_filename` (per `phase-03-videos/TD-15`)
2. Expor `@Get(':slug/download')` no `VideosController` respondendo `302` com `Location` e `Cache-Control: no-store`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService.downloadUrl` | Unit: `Content-Disposition` para nome ASCII, com aspas e com acentos (`aula 1 — introdução.mp4`) | `src/videos/video-delivery.service.spec.ts` |

**Dependencies:** SI-03.16 — reusa `VideoDeliveryService`

**Acceptance criteria:**

- `GET /videos/:slug/download` do dono para um vídeo `ready` retorna `302`; um GET na `Location` responde `200` com `Content-Disposition` começando com `attachment` e contendo o `original_filename`
- Para um `original_filename` com acentos, o header traz `filename*=UTF-8''` com o nome codificado
- Para um vídeo em `processing`, a rota retorna `409` com `error: "VIDEO_NOT_READY"`
- Outro usuário recebe `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.18 — Contrato OpenAPI e documentação do fluxo de upload

**Description:** Atualiza o `openapi.json` versionado com as 7 rotas de vídeo e documenta como subir o ambiente e executar o fluxo completo de upload, processamento e streaming.

**Technical actions:**

1. Rodar `npm run openapi:export` e versionar o `openapi.json` regenerado (per inherited `openapi-docs-nestjs/TD-02`)
2. Acrescentar ao `nestjs-project/api.http` a sequência `POST /videos` → `part-urls` → PUT das partes → `parts` → `complete` → `GET /videos/:slug` → `stream` → `download`
3. Atualizar `nestjs-project/CLAUDE.md` com os serviços `redis`, `rustfs` e `video-worker`, as checagens de prontidão (`redis-cli ping`, saúde do RustFS) e o comando de logs do worker

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | E2E: o documento servido em dev contém as 7 rotas de `/videos` e é igual ao arquivo versionado | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.11, SI-03.14, SI-03.17 — todas as rotas e o worker completos

**Acceptance criteria:**

- `openapi.json` contém `POST /videos`, `POST /videos/{id}/upload/part-urls`, `GET /videos/{id}/upload/parts`, `POST /videos/{id}/upload/complete`, `GET /videos/{slug}`, `GET /videos/{slug}/stream` e `GET /videos/{slug}/download`
- Rodar `npm run openapi:export` de novo não produz diff no `openapi.json`
- Seguindo só o `nestjs-project/CLAUDE.md`, `docker compose ps` mostra `nestjs-api`, `db`, `mailpit`, `redis`, `rustfs` e `video-worker` em execução

---

## Technical Specifications

### Data Model

#### Video

Table `videos`. Created as a draft when the upload starts *(per phase-03-videos/TD-08)*; processing outcome and publication state are independent columns *(per phase-03-videos/TD-08)*.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated. Also the BullMQ `jobId` *(per phase-03-videos/TD-07)* and the storage key prefix *(per phase-03-videos/TD-04)* |
| channel_id | uuid | not null, FK → `channels.id`, `ON DELETE CASCADE` |
| slug | varchar(11) | unique, not null. 11-char base64url from `crypto.randomBytes(8)`; regenerate on unique violation *(per phase-03-videos/TD-14)* |
| title | varchar(100) | not null. Defaults to the uploaded file name without extension (editing is Phase 04) |
| original_filename | varchar(255) | not null. Used for the download `Content-Disposition` *(per phase-03-videos/TD-15)* |
| mime_type | varchar(100) | not null. One of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` *(per phase-03-videos/TD-06)* |
| declared_size_bytes | bigint | not null. Client-declared size, ≤ 10 GiB *(per phase-03-videos/TD-06)* |
| processing_status | enum `video_processing_status` (`pending_upload`, `processing`, `ready`, `failed`) | not null, default `pending_upload` *(per phase-03-videos/TD-08)* |
| publication_status | enum `video_publication_status` (`draft`) | not null, default `draft`. Phase 04 extends the enum *(per phase-03-videos/TD-08)* |
| failure_reason | varchar(50) | nullable. Set only when `processing_status = failed` *(per phase-03-videos/TD-09)*. Values: `upload_expired`, `size_mismatch`, `invalid_media`, `processing_error` |
| upload_id | varchar(1024) | nullable. S3 multipart `UploadId` while `pending_upload`; cleared after complete or abort *(per phase-03-videos/TD-05)* |
| original_key | varchar(255) | not null. `videos/{id}/original` *(per phase-03-videos/TD-04)* |
| thumbnail_key | varchar(255) | nullable. `videos/{id}/thumbnail.jpg`, set when the thumbnail is stored *(per phase-03-videos/TD-04, phase-03-videos/TD-13)* |
| duration_seconds | numeric(10,3) | nullable *(per phase-03-videos/TD-11)* |
| width | integer | nullable *(per phase-03-videos/TD-11)* |
| height | integer | nullable *(per phase-03-videos/TD-11)* |
| video_codec | varchar(50) | nullable *(per phase-03-videos/TD-11)* |
| audio_codec | varchar(50) | nullable — videos without an audio stream keep it null *(per phase-03-videos/TD-11)* |
| container_format | varchar(100) | nullable *(per phase-03-videos/TD-11)* |
| bitrate | bigint | nullable, bits/s *(per phase-03-videos/TD-11)* |
| size_bytes | bigint | nullable. Actual object size from `HeadObject` on complete *(per phase-03-videos/TD-06, phase-03-videos/TD-11)* |
| processed_at | timestamptz | nullable. Set on transition to `ready` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), auto-updated |

`bigint` columns are mapped to `number` through a column transformer (all values stay below `Number.MAX_SAFE_INTEGER`); `numeric` is mapped to `number` the same way.

**Relations:** `Channel` has many `Video` (one-to-many, `videos.channel_id`). `Video` many-to-one `Channel`.
**Indexes:** unique on `slug`; index on `channel_id`; composite index on (`processing_status`, `created_at`) for the stale-upload sweep *(per phase-03-videos/TD-08)*.

### API Contracts

All endpoints require a valid access token (inherited global JWT guard, phase-02-auth/TD-02) and follow the inherited error envelope `{ statusCode, error, message }` (phase-02-auth/TD-07). Upload-management routes address the video by `id` (uuid, validated with `ParseUUIDPipe`); viewing routes address it by `slug`, the unique public identifier *(per phase-03-videos/TD-14)*. Response fields are snake_case, as in Phase 02.

**`VideoResponse` shape** (reused by several endpoints below):
- id: string (uuid)
- slug: string (11 chars)
- title: string
- original_filename: string
- mime_type: string
- processing_status: `pending_upload` | `processing` | `ready` | `failed`
- publication_status: `draft`
- failure_reason: string | null
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- audio_codec: string | null
- container_format: string | null
- bitrate: number | null
- size_bytes: number | null
- thumbnail_url: string | null — presigned GET on `S3_PUBLIC_ENDPOINT`, present only when `thumbnail_key` is set *(per phase-03-videos/TD-04, phase-03-videos/TD-15)*
- created_at: string (ISO-8601)
- processed_at: string (ISO-8601) | null

---

#### POST /videos (SI-03.6)

Creates the draft `Video` and starts the S3 multipart upload in the same request *(per phase-03-videos/TD-05, phase-03-videos/TD-08)*. The video belongs to the caller's channel.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- filename: string, required — 1..255 characters
- mime_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- size_bytes: integer, required — 1..10737418240 (10 GiB)
- title: string, optional — 1..100 characters; defaults to `filename` without its extension

**Response 201:**
- `VideoResponse` fields (`processing_status: pending_upload`, metadata fields null)
- upload: object
  - part_size_bytes: number — always 67108864 (64 MiB, server-defined)
  - part_count: number — `ceil(size_bytes / part_size_bytes)`

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation (unsupported `mime_type`, `size_bytes` above 10 GiB, missing fields)
- 401 (inherited guard): when the access token is missing or invalid

---

#### POST /videos/:id/upload/part-urls (SI-03.7)

Signs part-upload URLs on `S3_PUBLIC_ENDPOINT` for the parts the client is about to send. Called at start and again on resume, since URLs expire *(per phase-03-videos/TD-05, phase-03-videos/TD-06)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- part_numbers: integer[], required — 1..100 items, each ≥ 1, no duplicates

**Response 200:**
- parts: array of `{ part_number: number, url: string }` — presigned `UploadPart` PUT URLs
- expires_at: string (ISO-8601) — now + 1h

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller's channel
- 409 VIDEO_UPLOAD_NOT_PENDING: when `processing_status` is not `pending_upload`
- 400 INVALID_PART_NUMBER: when a `part_number` is greater than the video's `part_count`
- 400 VALIDATION_ERROR: when the body fails validation or `:id` is not a uuid

---

#### GET /videos/:id/upload/parts (SI-03.7)

Lists parts already stored for the open multipart upload, so the client can resume *(per phase-03-videos/TD-05)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- parts: array of `{ part_number: number, etag: string, size_bytes: number }`, ordered by `part_number`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller's channel
- 409 VIDEO_UPLOAD_NOT_PENDING: when `processing_status` is not `pending_upload`
- 400 VALIDATION_ERROR: when `:id` is not a uuid

---

#### POST /videos/:id/upload/complete (SI-03.8)

Completes the multipart upload, checks the stored size with `HeadObject`, sets `processing_status = processing`, commits, then enqueues `process-video` with `jobId = id` *(per phase-03-videos/TD-06, phase-03-videos/TD-07)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array, required — 1..10000 items, each:
  - part_number: integer, required — ≥ 1
  - etag: string, required — non-empty, as returned by the storage `ETag` response header

**Response 200:**
- `VideoResponse` fields (`processing_status: processing`, `size_bytes` set)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller's channel
- 409 VIDEO_UPLOAD_NOT_PENDING: when `processing_status` is not `pending_upload` (includes a repeated complete call)
- 400 UPLOAD_INCOMPLETE: when storage rejects the part list (missing part, wrong ETag, wrong order, part too small); the multipart upload stays open so the client can fix and retry
- 422 UPLOAD_SIZE_MISMATCH: when the stored object size differs from `declared_size_bytes` or exceeds 10 GiB; the object is deleted and the video set to `failed` with `failure_reason = size_mismatch`
- 400 VALIDATION_ERROR: when the body fails validation or `:id` is not a uuid

---

#### GET /videos/:slug (SI-03.12)

Returns the video and its processing state to the owner *(per phase-03-videos/TD-16)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- `VideoResponse`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this slug or it is not owned by the caller's channel

---

#### GET /videos/:slug/stream (SI-03.13)

Authorizes, then redirects to a presigned GET on `S3_PUBLIC_ENDPOINT`. Storage serves `Range` requests with `206`, so the client never downloads the whole file *(per phase-03-videos/TD-15, phase-03-videos/TD-16)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: presigned GET URL for `videos/{id}/original`, TTL 1h
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this slug or it is not owned by the caller's channel
- 409 VIDEO_NOT_READY: when `processing_status` is not `ready`

---

#### GET /videos/:slug/download (SI-03.13)

Same as stream, but the presigned GET carries `ResponseContentDisposition: attachment; filename="{original_filename}"` (with an RFC 5987 `filename*` for non-ASCII names) *(per phase-03-videos/TD-15, phase-03-videos/TD-16)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: presigned GET URL with `response-content-disposition`, TTL 1h
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this slug or it is not owned by the caller's channel
- 409 VIDEO_NOT_READY: when `processing_status` is not `ready`

---

#### Validation Rules — Upload

- `mime_type`: `IsIn` the four accepted MIME types *(per phase-03-videos/TD-06)*
- `size_bytes`: `IsInt`, `Min(1)`, `Max(10737418240)` *(per phase-03-videos/TD-06)*
- `part_numbers`: `ArrayMinSize(1)`, `ArrayMaxSize(100)`, `ArrayUnique`, each `IsInt` + `Min(1)`; the upper bound (`part_count`) is a domain check, not a DTO rule
- `parts`: `ArrayMinSize(1)`, `ArrayMaxSize(10000)`, `ValidateNested` + `Type(() => CompletedPartDto)`
- The limits (10 GiB max size, 64 MiB part size, 1h URL TTL, MIME list) live in one exported constants module in `src/videos/`; DTO decorators and services both import it, so no value is repeated as a literal

### Authorization Matrix

In Phase 03 every video is a draft, so every route is owner-only *(per phase-03-videos/TD-16)*. "Owner" means `video.channel_id` equals the channel of the authenticated user (`CurrentUser().sub` → `channels.user_id`). A non-owner gets `404 VIDEO_NOT_FOUND`, not `403`, so the existence of drafts is not revealed.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates own video) | — |
| POST /videos/:id/upload/part-urls | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug/stream | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug/download | ✗ (401) | ✗ (404) | ✓ |

Presigned URLs returned by these endpoints are bearer capabilities until they expire (1h); the authorization check happens when they are issued *(per phase-03-videos/TD-15)*.

### Error Catalog

Error response format is inherited from Phase 02: `{ statusCode, error, message }`, with `error` carrying the code below *(phase-02-auth/TD-07)*.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:id/...` or `/videos/:slug...` route when the video does not exist or belongs to another channel |
| VIDEO_UPLOAD_NOT_PENDING | 409 | Video upload is not pending | part-urls, parts or complete when `processing_status` is not `pending_upload` |
| INVALID_PART_NUMBER | 400 | Part number is out of range | part-urls with a `part_number` greater than the video's `part_count` |
| UPLOAD_INCOMPLETE | 400 | Uploaded parts are incomplete or invalid | complete when storage rejects the part list (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size does not match the declared size | complete when `HeadObject` `ContentLength` differs from `declared_size_bytes` or exceeds 10 GiB |
| VIDEO_NOT_READY | 409 | Video is not ready | stream or download when `processing_status` is not `ready` |

Worker-side failures are not HTTP errors; they are recorded on the row as `failure_reason` (see Events/Messages).

### Events/Messages

Both queues live in Redis through BullMQ *(per phase-03-videos/TD-01)*. The API process only produces; the consumers run in the `video-worker` process started from `src/worker.ts` *(per phase-03-videos/TD-10)*. Queue names and job names are exported constants of the `video-processing` module; other modules import them only from its public `index.ts`.

#### process-video (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (duplicate enqueue is ignored), `attempts: 3`, `backoff: { type: 'exponential', delay: 30000 }`, `removeOnComplete: true`, `removeOnFail: 1000` *(per phase-03-videos/TD-07, phase-03-videos/TD-09)*
**Producer:** `VideoUploadService.complete()` in the API, after the transaction that sets `processing_status = processing` commits (per `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessingProcessor` in the worker (per `phase-03-videos/TD-10`), which:
1. Loads the video; does nothing if `processing_status` is not `processing` (repeated delivery after success).
2. Signs a GET URL on the internal `S3_ENDPOINT` and runs `ffprobe -print_format json -show_format -show_streams` on it *(per phase-03-videos/TD-11, phase-03-videos/TD-12)*.
3. No video stream, or ffprobe exits non-zero on a reachable object → throws `UnrecoverableError` (bad media).
4. Extracts one frame at ~10% of `duration_seconds` (0 for clips under 1s), JPEG 1280px wide, aspect preserved, and `PutObject`s it to `videos/{id}/thumbnail.jpg` *(per phase-03-videos/TD-13)*.
5. Persists `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container_format`, `bitrate`, `thumbnail_key`, `processed_at` and sets `processing_status = ready` in one update *(per phase-03-videos/TD-11)*.
**Failure outcome:** `UnrecoverableError` → `processing_status = failed`, `failure_reason = invalid_media`. Any other error is retried; once the last attempt fails → `processing_status = failed`, `failure_reason = processing_error` *(per phase-03-videos/TD-09)*.
**Trigger:** a successful `POST /videos/:id/upload/complete`.
**Delivery semantics:** at-least-once; the consumer is idempotent (status guard in step 1, fixed thumbnail key) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)

#### expire-stale-uploads (queue `video-maintenance`)

**Payload:**

```json
{}
```

**Scheduler:** `queue.upsertJobScheduler('expire-stale-uploads', { every: 3600000 }, { name: 'expire-stale-uploads' })`, called on every worker boot (idempotent per scheduler id) *(per phase-03-videos/TD-08)*
**Producer:** the BullMQ job scheduler, registered by the worker on boot
**Consumer:** `StaleUploadSweepProcessor` in the worker, which selects videos with `processing_status = pending_upload` and `created_at < now() - 24h`, calls `AbortMultipartUpload` for each `upload_id` (ignoring `NoSuchUpload`), and sets `processing_status = failed`, `failure_reason = upload_expired`, `upload_id = null` *(per phase-03-videos/TD-08)*
**Trigger:** every hour.
**Delivery semantics:** at-least-once; re-running the sweep on the same rows is a no-op because they are no longer `pending_upload`. Backstop: the bucket lifecycle rule `AbortIncompleteMultipartUpload` (2 days) cleans parts even if the sweep never runs *(per phase-03-videos/TD-08)*.

---

## Dependency Map

```
SI-03.1 (root — Redis, RustFS, ffmpeg)
└── SI-03.2 — depends on SI-03.1 (config defaults point at the new services)
    ├── SI-03.3 — depends on SI-03.2 (StorageModule needs storageConfig + SDK)
    │   ├── SI-03.4 — depends on SI-03.3 (compatibility gate exercises StorageService)
    │   │   ├── SI-03.8 — also depends on SI-03.5, SI-03.6 (upload SIs only after the gate passes)
    │   │   │   ├── SI-03.9 — depends on SI-03.8 (VideoUploadService, VideosController)
    │   │   │   │   ├── SI-03.10 — depends on SI-03.9 (parts uploaded via signed URLs)
    │   │   │   │   │   └── SI-03.11 — depends on SI-03.10 (complete + enqueue process-video)
    │   │   │   │   │       ├── SI-03.13 — also depends on SI-03.12 (processor consumes the job)
    │   │   │   │   │       │   ├── SI-03.15 — also depends on SI-03.9 (GET /videos/:slug)
    │   │   │   │   │       │   │   └── SI-03.16 — also depends on SI-03.13 (stream needs ready videos)
    │   │   │   │   │       │   │       └── SI-03.17 — depends on SI-03.16 (download reuses VideoDeliveryService)
    │   │   │   │   │       │   │           └── SI-03.18 — also depends on SI-03.11, SI-03.14 (OpenAPI + docs)
    │   │   │   └── SI-03.14 — also depends on SI-03.7 (stale-upload sweep runs in the worker)
    │   │   └── SI-03.12 — also depends on SI-03.7 (ffmpeg wrapper uses the gate's fixture)
    │   └── SI-03.7 — also depends on SI-03.6 (worker entrypoint imports Storage/Database/Queue modules)
    └── SI-03.6 — depends on SI-03.2 (BullMQ root + DatabaseModule extraction)
SI-03.5 (root, independent — Video entity + migration + slug)
```

Critical path: SI-03.1 → 03.2 → 03.3 → 03.4 → 03.8 → 03.9 → 03.10 → 03.11 → 03.13 → 03.15 → 03.16 → 03.17 → 03.18. SI-03.5, SI-03.6/03.7 and SI-03.12 can run in parallel with the upload chain once their own dependencies are met.

---

## Deliverables

- [ ] SI-03.1 — Infra: Redis, RustFS e FFmpeg no ambiente Docker
- [ ] SI-03.2 — Infra: dependências e namespaces de configuração de storage e fila
- [ ] SI-03.3 — Módulo de storage com clientes interno e público
- [ ] SI-03.4 — Gate de compatibilidade do storage (RustFS)
- [ ] SI-03.5 — Entidade Video, migration e gerador de slug
- [ ] SI-03.6 — Infra: BullMQ na API e módulo de banco compartilhável
- [ ] SI-03.7 — Infra: entrypoint do worker e fronteira entre módulos
- [ ] SI-03.8 — Endpoint POST /videos (pré-cadastro do rascunho e início do upload)
- [ ] SI-03.9 — Endpoint POST /videos/:id/upload/part-urls
- [ ] SI-03.10 — Endpoint GET /videos/:id/upload/parts (retomada)
- [ ] SI-03.11 — Endpoint POST /videos/:id/upload/complete (conclusão e enfileiramento)
- [ ] SI-03.12 — Wrapper tipado de ffprobe e ffmpeg
- [ ] SI-03.13 — Processor process-video (metadados, thumbnail e status final)
- [ ] SI-03.14 — Varredura horária de uploads abandonados
- [ ] SI-03.15 — Endpoint GET /videos/:slug (detalhe e status)
- [ ] SI-03.16 — Endpoint GET /videos/:slug/stream (reprodução via streaming)
- [ ] SI-03.17 — Endpoint GET /videos/:slug/download
- [ ] SI-03.18 — Contrato OpenAPI e documentação do fluxo de upload

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
