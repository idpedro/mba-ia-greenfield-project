---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-detail.e2e-spec.ts
---

# GET /videos/:slug — Test Plan

## Application Overview

`GET /videos/:slug` devolve ao dono o `VideoResponse` do vídeo pela sua URL única: status de processamento, metadados extraídos e `thumbnail_url` assinada no host público quando a thumbnail existe. Slugs com formato inválido, inexistentes ou de outro canal respondem `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. GET /videos/:slug

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com canal (dono e outro) e faz login de ambos; os vídeos em cada estado são semeados no repositório de `Video` no canal do dono (o `ready` com metadados preenchidos e `thumbnail_key` de um JPEG real gravado no RustFS pelo `StorageService`); RustFS e Redis reais da rede Compose, com `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no ambiente de teste para que as URLs assinadas saiam com o host que o container alcança (a assinatura SigV4 inclui o host, então ele não pode ser reescrito depois); `afterAll(() => app.close())`.

#### 1.1. video-ready-com-metadados-e-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug com o token do dono para o vídeo `ready`
    - expect: status `200`
    - expect: `processing_status: "ready"` e metadados (`duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `size_bytes`) preenchidos
    - expect: `thumbnail_url` no host de `S3_PUBLIC_ENDPOINT`
  2. GET na `thumbnail_url`, sem alterar a URL
    - expect: status `200` com `Content-Type: image/jpeg`

#### 1.2. video-pending-upload-sem-metadados

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug com o token do dono para um vídeo criado via POST /videos (em `pending_upload`)
    - expect: status `200`
    - expect: `processing_status: "pending_upload"`, metadados nulos e `thumbnail_url: null`

#### 1.3. video-failed-com-failure-reason

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug com o token do dono para um vídeo `failed` com `failure_reason` semeado
    - expect: status `200`
    - expect: `processing_status: "failed"` e `failure_reason` preenchido

#### 1.4. outro-usuario-recebe-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug com o token do outro usuário para o slug do vídeo `ready` do dono
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 1.5. slug-inexistente-ou-malformado-recebe-not-found

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug com o token do dono e um slug de 11 caracteres base64url que não existe
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:slug com o token do dono e um slug de formato inválido (ex.: `curto`)
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`
