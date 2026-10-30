---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/:slug/stream — Test Plan

## Application Overview

`GET /videos/:slug/stream` autoriza o dono e responde `302` para uma URL assinada (TTL 1h) do `original_key` no host público do storage, com `Cache-Control: no-store`. O storage atende `Range` com `206`, então o cliente reproduz sem baixar o arquivo inteiro e nenhum byte de vídeo passa pela API. Vídeos fora de `ready` respondem `409 VIDEO_NOT_READY`; de outro canal, `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. GET /videos/:slug/stream

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com canal (dono e outro), faz login de ambos e semeia no canal do dono um vídeo `ready` cujo `original_key` aponta para um objeto de vídeo real (≥ 1024 bytes) gravado no RustFS pelo `StorageService`, além de um vídeo em `processing`; RustFS e Redis reais da rede Compose, com `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no ambiente de teste para que as URLs assinadas saiam com o host que o container alcança (a assinatura SigV4 inclui o host, então ele não pode ser reescrito depois); `afterAll(() => app.close())`.

#### 1.1. redireciona-para-url-assinada-com-suporte-a-range

**Covers AC:** #1, #2, #5
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/stream com o token do dono para o vídeo `ready`, sem seguir redirects
    - expect: status `302`
    - expect: header `Location` no host de `S3_PUBLIC_ENDPOINT`
    - expect: header `Cache-Control: no-store`
    - expect: corpo da resposta vazio (nenhum byte do vídeo)
  2. GET na `Location`, sem alterar a URL, com `Range: bytes=0-1023`
    - expect: status `206`
    - expect: corpo com exatamente 1024 bytes

#### 1.2. video-nao-ready-retorna-conflito

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/stream com o token do dono para o vídeo em `processing`
    - expect: status `409`
    - expect: body `error: "VIDEO_NOT_READY"`

#### 1.3. outro-usuario-recebe-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/stream com o token do outro usuário para o vídeo `ready` do dono
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`
