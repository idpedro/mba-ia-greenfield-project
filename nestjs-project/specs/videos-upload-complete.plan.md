---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` conclui o multipart com a lista de `part_number`/`etag`, confere o tamanho gravado via `HeadObject`, muda o vídeo para `processing` (com `WHERE processing_status = 'pending_upload'`, então só um `complete` concorrente vence) e, só depois do commit, publica o job `process-video` na fila `video-processing` com `jobId = videoId`. Uma lista de partes inválida devolve `UPLOAD_INCOMPLETE` e mantém o multipart aberto; um tamanho divergente apaga o objeto e deixa o vídeo `failed` com `size_mismatch`.

## Test Scenarios

### 1. POST /videos/:id/upload/complete

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`) e obtém a fila `video-processing` via `getQueueToken(VIDEO_PROCESSING_QUEUE)`; `beforeEach` roda `cleanAllTables(dataSource)`, esvazia a fila (`queue.obliterate({ force: true })`), cria um usuário confirmado com canal e faz login; o vídeo de cada cenário é criado via `POST /videos` com um `size_bytes` pequeno o bastante para o teste (ex.: uma parte única), e as partes são enviadas por PUT nas URLs de `POST /videos/:id/upload/part-urls`; RustFS e Redis reais da rede Compose, com `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no ambiente de teste para que as URLs assinadas saiam com o host que o container alcança (a assinatura SigV4 inclui o host, então ele não pode ser reescrito depois); `afterAll(() => app.close())`.

#### 1.1. conclui-upload-e-enfileira-process-video

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Enviar todas as partes do vídeo e guardar os `ETag`
  2. POST /videos/:id/upload/complete com `{ parts: [{ part_number, etag }, ...] }`
    - expect: status `200`
    - expect: body com `processing_status: "processing"` e `size_bytes` igual ao `size_bytes` declarado
  3. Ler o job `<id do vídeo>` na fila `video-processing`
    - expect: o job existe com nome `process-video`, id igual ao `id` do vídeo e `data` igual a `{ videoId: "<id>" }`

#### 1.2. complete-repetido-retorna-conflito-sem-segundo-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Concluir o upload com sucesso (como em 1.1)
  2. Repetir o mesmo POST /videos/:id/upload/complete
    - expect: status `409`
    - expect: body `error: "VIDEO_UPLOAD_NOT_PENDING"`
    - expect: a fila `video-processing` continua com um único job para esse vídeo

#### 1.3. etag-errado-mantem-pending-upload-e-aceita-retry

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Enviar todas as partes e chamar POST /videos/:id/upload/complete trocando o `etag` de uma parte por um valor errado
    - expect: status `400`
    - expect: body `error: "UPLOAD_INCOMPLETE"`
    - expect: a linha em `videos` continua com `processing_status = pending_upload` e `upload_id` preenchido
    - expect: nenhum job na fila para esse vídeo
  2. Repetir o POST /videos/:id/upload/complete com os `etag` corretos
    - expect: status `200` com `processing_status: "processing"`

#### 1.4. tamanho-divergente-falha-e-apaga-objeto

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Criar via POST /videos um vídeo com `size_bytes` maior que os bytes que serão de fato enviados (mesmo `part_count`), enviar as partes e guardar os `ETag`
  2. POST /videos/:id/upload/complete com as partes corretas
    - expect: status `422`
    - expect: body `error: "UPLOAD_SIZE_MISMATCH"`
    - expect: a linha em `videos` tem `processing_status = failed`, `failure_reason = size_mismatch` e `upload_id` nulo
    - expect: `HeadObject` em `videos/{id}/original` no storage retorna not found
    - expect: nenhum job na fila para esse vídeo
