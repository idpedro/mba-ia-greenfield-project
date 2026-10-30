---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:id/upload/part-urls — Test Plan

## Application Overview

`POST /videos/:id/upload/part-urls` assina, no cliente público (`S3_PUBLIC_ENDPOINT`), as URLs de `UploadPart` que o cliente usa para enviar as partes direto ao storage — no início e de novo ao retomar, já que as URLs expiram em 1h. Só o dono do vídeo pode pedir (vídeo de outro canal responde `404`, igual a inexistente), o vídeo precisa estar em `pending_upload` e cada `part_number` precisa estar dentro de `part_count`.

## Test Scenarios

### 1. POST /videos/:id/upload/part-urls

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com canal (dono e outro), faz login de ambos e cria via `POST /videos` um vídeo de 3 partes (`size_bytes: 200000000`) do dono; RustFS e Redis reais da rede Compose, com `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no ambiente de teste para que as URLs assinadas saiam com o host que o container alcança (a assinatura SigV4 inclui o host, então ele não pode ser reescrito depois); `afterAll(() => app.close())`.

#### 1.1. assina-urls-de-parte-no-host-publico

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com o token do dono e body `{ part_numbers: [1, 2] }`
    - expect: status `200`
    - expect: `parts` com 2 itens `{ part_number, url }` para as partes 1 e 2
    - expect: cada `url` aponta para o host de `S3_PUBLIC_ENDPOINT`
    - expect: `expires_at` cerca de 1h no futuro (tolerância de alguns segundos)
  2. PUT de bytes da parte 1 na `url` devolvida para a parte 1, sem alterar a URL
    - expect: status `200` com header `ETag`

#### 1.2. rejeita-part-number-fora-do-intervalo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com o token do dono e `{ part_numbers: [999] }` para o vídeo de 3 partes
    - expect: status `400`
    - expect: body `error: "INVALID_PART_NUMBER"`

#### 1.3. outro-usuario-recebe-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com o token do outro usuário e `{ part_numbers: [1] }`
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 1.4. rejeita-video-fora-de-pending-upload

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Atualizar no banco o `processing_status` do vídeo para `processing`
  2. POST /videos/:id/upload/part-urls com o token do dono e `{ part_numbers: [1] }`
    - expect: status `409`
    - expect: body `error: "VIDEO_UPLOAD_NOT_PENDING"`

#### 1.5. rejeita-id-que-nao-e-uuid

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. POST /videos/nao-e-uuid/upload/part-urls com o token do dono e `{ part_numbers: [1] }`
    - expect: status `400`
