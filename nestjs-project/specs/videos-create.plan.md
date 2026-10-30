---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload: cria o `Video` como rascunho (`pending_upload` / `draft`) no canal do usuário autenticado, abre o multipart S3 no RustFS (`videos/{id}/original`) e devolve o `VideoResponse` mais o plano de upload (`part_size_bytes` fixo em 64 MiB, `part_count = ceil(size_bytes / part_size_bytes)`). O body é validado contra os limites de upload (10 GiB, apenas MIME de vídeo) e a rota fica atrás do guard JWT global herdado.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` whitelist/forbidNonWhitelisted/transform + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` roda `cleanAllTables(dataSource)` e cria um usuário confirmado com canal, fazendo login para obter o `access_token`; RustFS (`rustfs`) e Redis (`redis`) reais da rede Compose; `afterAll(() => app.close())`.

#### 1.1. cria-rascunho-e-abre-multipart

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 200000000 }`
    - expect: status `201`
    - expect: body com `processing_status: "pending_upload"`, `publication_status: "draft"`, `title: "aula"`
    - expect: `slug` com 11 caracteres base64url e `id` uuid
    - expect: `upload` igual a `{ part_size_bytes: 67108864, part_count: 3 }`
    - expect: metadados (`duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container_format`, `bitrate`, `size_bytes`) e `thumbnail_url` nulos
  2. Consultar a tabela `videos` pelo `id` devolvido
    - expect: a linha existe, pertence ao canal do usuário autenticado, com `upload_id` preenchido e `original_key = videos/{id}/original`

#### 1.2. rejeita-tamanho-acima-de-10-gib

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos autenticado com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 10737418241 }`
    - expect: status `400`
    - expect: body `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha em `videos`

#### 1.3. rejeita-mime-type-nao-suportado

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos autenticado com `{ filename: "foto.png", mime_type: "image/png", size_bytes: 1000 }`
    - expect: status `400`
    - expect: body `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha em `videos`

#### 1.4. exige-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhuma linha em `videos`
