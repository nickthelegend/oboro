pub mod wire;

use anyhow::{bail, Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::Response as AxumResponse,
    routing::{any, get},
    Json, Router,
};
use chrono::{DateTime, Utc};
use nym_sdk::mixnet::{self, MixnetClient, MixnetStream, Recipient};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    net::TcpListener,
    sync::{Mutex, RwLock},
};
use wire::{Headers, Request, Response};

const SENDER_VISIBLE: &str = "SURB reply tag only (no IP, no Nym address)";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub seq: u64,
    pub ts: DateTime<Utc>,
    pub kind: String,
    pub stream_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_in: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_out: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_visible: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_names: Option<Vec<String>>,
}
impl Event {
    fn new(kind: &str, stream_id: String) -> Self {
        Self {
            seq: 0,
            ts: Utc::now(),
            kind: kind.into(),
            stream_id,
            method: None,
            path: None,
            status: None,
            bytes_in: None,
            bytes_out: None,
            ms: None,
            sender_visible: None,
            recipient: None,
            header_names: None,
        }
    }
}

pub struct Events {
    seq: AtomicU64,
    recent: RwLock<VecDeque<Event>>,
    file: Mutex<tokio::fs::File>,
}
impl Events {
    pub async fn new(dir: &Path) -> Result<Arc<Self>> {
        fs::create_dir_all(dir)
            .await
            .context("create data directory")?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("events.jsonl"))
            .await
            .context("open events.jsonl")?;
        Ok(Arc::new(Self {
            seq: AtomicU64::new(0),
            recent: RwLock::new(VecDeque::with_capacity(500)),
            file: Mutex::new(file),
        }))
    }
    pub async fn push(&self, mut event: Event) -> Result<()> {
        let mut file = self.file.lock().await;
        event.seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        file.write_all(serde_json::to_string(&event)?.as_bytes())
            .await
            .context("append event")?;
        file.write_all(b"\n")
            .await
            .context("append event newline")?;
        let mut recent = self.recent.write().await;
        if recent.len() == 500 {
            recent.pop_front();
        }
        recent.push_back(event);
        Ok(())
    }
    pub async fn since(&self, seq: u64) -> Vec<Event> {
        self.recent
            .read()
            .await
            .iter()
            .filter(|e| e.seq > seq)
            .cloned()
            .collect()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    role: &'static str,
    nym_address: String,
    upstream: Option<String>,
    started_at: DateTime<Utc>,
    served: u64,
    errors: u64,
}
struct Shared {
    role: &'static str,
    address: String,
    upstream: Option<String>,
    started_at: DateTime<Utc>,
    served: AtomicU64,
    errors: AtomicU64,
    events: Arc<Events>,
}
impl Shared {
    fn new(
        role: &'static str,
        address: String,
        upstream: Option<String>,
        events: Arc<Events>,
    ) -> Arc<Self> {
        Arc::new(Self {
            role,
            address,
            upstream,
            started_at: Utc::now(),
            served: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            events,
        })
    }
}
#[derive(Deserialize)]
struct Since {
    since: Option<u64>,
}
async fn status(State(s): State<Arc<Shared>>) -> Json<Status> {
    Json(Status {
        role: s.role,
        nym_address: s.address.clone(),
        upstream: s.upstream.clone(),
        started_at: s.started_at,
        served: s.served.load(Ordering::Relaxed),
        errors: s.errors.load(Ordering::Relaxed),
    })
}
async fn events(State(s): State<Arc<Shared>>, Query(q): Query<Since>) -> Json<Vec<Event>> {
    Json(s.events.since(q.since.unwrap_or(0)).await)
}

pub async fn connect_persistent(data: &Path, nym_env: Option<&Path>) -> Result<MixnetClient> {
    if let Some(path) = nym_env {
        dotenvy::from_path(path).with_context(|| format!("load Nym env {}", path.display()))?;
    }
    let nym_dir = data.join("nym");
    fs::create_dir_all(&nym_dir)
        .await
        .context("create Nym storage")?;
    let paths = mixnet::StoragePaths::new_from_dir(&nym_dir).context("Nym storage paths")?;
    let mut builder = mixnet::MixnetClientBuilder::new_with_default_storage(paths)
        .await
        .context("Nym storage builder")?;
    if nym_env.is_some() {
        builder = builder.network_details(mixnet::NymNetworkDetails::new_from_env());
    }
    builder
        .build()
        .context("build Nym client")?
        .connect_to_mixnet()
        .await
        .context("connect to Nym mixnet")
}

fn header_pairs(headers: &HeaderMap) -> Result<Headers> {
    headers
        .iter()
        .map(|(k, v)| {
            Ok((
                k.to_string(),
                v.to_str()
                    .with_context(|| format!("non-UTF-8 header value for {k}"))?
                    .to_string(),
            ))
        })
        .collect()
}
fn names(headers: &Headers) -> Vec<String> {
    headers.iter().map(|(k, _)| k.clone()).collect()
}
fn safe_headers(headers: &Headers) -> Result<HeaderMap> {
    let mut out = HeaderMap::new();
    for (k, v) in wire::strip_headers(headers) {
        let name = HeaderName::from_bytes(k.as_bytes())
            .with_context(|| format!("invalid header name {k}"))?;
        let value =
            HeaderValue::from_str(&v).with_context(|| format!("invalid header value for {k}"))?;
        out.append(name, value);
    }
    Ok(out)
}
fn http_response(status: u16, headers: &Headers, body: Vec<u8>) -> Result<AxumResponse> {
    let mut response = AxumResponse::builder().status(StatusCode::from_u16(status)?);
    *response.headers_mut().context("response headers")? = safe_headers(headers)?;
    Ok(response.body(Body::from(body))?)
}
fn json_error(status: StatusCode, code: &str, detail: Option<String>) -> AxumResponse {
    let body = if let Some(detail) = detail {
        serde_json::json!({"error":code,"detail":detail})
    } else {
        serde_json::json!({"error":code})
    };
    AxumResponse::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn forward(
    req: &Request,
    upstream: &str,
    stream_id: &str,
    mix_in_ms: u128,
    client: &reqwest::Client,
) -> Result<Response> {
    if req.v != 1 {
        bail!("unsupported wire version {}", req.v);
    }
    if !req.path.starts_with('/') {
        bail!("request path must begin with /");
    }
    let url = format!("{}{}", upstream.trim_end_matches('/'), req.path);
    let method: reqwest::Method = req.method.parse().context("invalid HTTP method")?;
    let mut headers = safe_headers(&req.headers)?;
    headers.insert("x-oboro-transport", HeaderValue::from_static("nym-mixnet"));
    headers.insert("x-oboro-stream", HeaderValue::from_str(stream_id)?);
    headers.insert(
        "x-oboro-mix-in-ms",
        HeaderValue::from_str(&mix_in_ms.to_string())?,
    );
    let body = wire::decoded_body(&req.body_b64)?;
    let resp = client
        .request(method, url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .context("upstream request")?;
    let status = resp.status().as_u16();
    let headers = wire::strip_headers(&header_pairs(resp.headers())?);
    let bytes = resp.bytes().await.context("read upstream body")?;
    Ok(Response {
        v: 1,
        id: req.id.clone(),
        status,
        headers,
        body_b64: wire::encoded_body(&bytes),
    })
}
async fn gate_stream(
    mut stream: MixnetStream,
    shared: Arc<Shared>,
    upstream: String,
    client: reqwest::Client,
) -> Result<()> {
    let started = Instant::now();
    let id = stream.id().to_string();
    let mut opened = Event::new("stream_open", id.clone());
    opened.sender_visible = Some(SENDER_VISIBLE);
    shared.events.push(opened).await?;
    // Handshake: tell the sender the stream is registered before it sends the request.
    wire::write(&mut stream, &wire::Ready { v: 1, ready: true })
        .await
        .context("write ready frame")?;
    let (req, bytes_in): (Request, usize) =
        tokio::time::timeout(Duration::from_secs(120), wire::read(&mut stream))
            .await
            .context("request read timeout (120s)")??;
    let mut request_event = Event::new("request", id.clone());
    request_event.sender_visible = Some(SENDER_VISIBLE);
    request_event.method = Some(req.method.clone());
    request_event.path = Some(req.path.clone());
    request_event.bytes_in = Some(bytes_in);
    request_event.ms = Some(started.elapsed().as_millis());
    request_event.header_names = Some(names(&req.headers));
    shared.events.push(request_event).await?;
    let response = if req.method == "GET" && req.path == "/oboro/ping" {
        Response {
            v: 1,
            id: req.id.clone(),
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body_b64: wire::encoded_body(br#"{"pong":true,"role":"gate"}"#),
        }
    } else {
        match forward(&req, &upstream, &id, started.elapsed().as_millis(), &client).await {
            Ok(resp) => resp,
            Err(err) => {
                shared.errors.fetch_add(1, Ordering::Relaxed);
                let mut event = Event::new("error", id.clone());
                event.method = Some(req.method.clone());
                event.path = Some(req.path.clone());
                event.sender_visible = Some(SENDER_VISIBLE);
                shared.events.push(event).await?;
                Response { v: 1, id: req.id.clone(), status: 502, headers: vec![("content-type".into(), "application/json".into())], body_b64: wire::encoded_body(serde_json::json!({"error":"upstream_unreachable","detail":err.to_string()}).to_string().as_bytes()) }
            }
        }
    };
    let bytes_out = wire::write(&mut stream, &response).await?;
    let mut event = Event::new("response", id);
    event.method = Some(req.method);
    event.path = Some(req.path);
    event.status = Some(response.status);
    event.bytes_in = Some(bytes_in);
    event.bytes_out = Some(bytes_out);
    event.ms = Some(started.elapsed().as_millis());
    event.sender_visible = Some(SENDER_VISIBLE);
    event.header_names = Some(names(&response.headers));
    shared.events.push(event).await?;
    shared.served.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

pub async fn run_gate(
    upstream: String,
    data: PathBuf,
    status_addr: SocketAddr,
    nym_env: Option<PathBuf>,
) -> Result<()> {
    let client = connect_persistent(&data, nym_env.as_deref()).await?;
    run_gate_with_client(client, upstream, data, status_addr).await
}
pub async fn run_gate_with_client(
    mut client: MixnetClient,
    upstream: String,
    data: PathBuf,
    status_addr: SocketAddr,
) -> Result<()> {
    let address = client.nym_address().to_string();
    let mut listener = client.listener().context("activate Nym listener")?;
    let events = Events::new(&data).await?;
    let shared = Shared::new("gate", address.clone(), Some(upstream.clone()), events);
    let status_listener = TcpListener::bind(status_addr)
        .await
        .context("bind gate status")?;
    let app = Router::new()
        .route("/status", get(status))
        .route("/events", get(events_handler))
        .with_state(shared.clone());
    tokio::spawn(async move {
        if let Err(e) = axum::serve(status_listener, app).await {
            eprintln!("gate status server: {e}");
        }
    });
    fs::write(data.join("address.txt"), format!("{address}\n"))
        .await
        .context("write gate address")?;
    println!(
        "{}",
        serde_json::json!({"event":"ready","role":"gate","nymAddress":address})
    );
    let upstream_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(110))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    while let Some(stream) = listener.accept().await {
        let shared = shared.clone();
        let upstream = upstream.clone();
        let http = upstream_client.clone();
        tokio::spawn(async move {
            let id = stream.id().to_string();
            if let Err(err) = gate_stream(stream, shared.clone(), upstream, http).await {
                shared.errors.fetch_add(1, Ordering::Relaxed);
                let mut event = Event::new("error", id);
                event.sender_visible = Some(SENDER_VISIBLE);
                if let Err(log_err) = shared.events.push(event).await {
                    eprintln!("gate event log: {log_err:#}");
                }
                eprintln!("gate stream error: {err:#}");
            }
        });
    }
    bail!("Nym listener closed")
}
async fn events_handler(State(s): State<Arc<Shared>>, Query(q): Query<Since>) -> Json<Vec<Event>> {
    events(State(s), Query(q)).await
}

struct TunnelState {
    client: Mutex<MixnetClient>,
    shared: Arc<Shared>,
    timeout: Duration,
}
async fn tunnel_request(
    State(state): State<Arc<TunnelState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> AxumResponse {
    let started = Instant::now();
    let full_path = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or(uri.path());
    let (recipient, path) = match wire::parse_nym_path(full_path) {
        Ok(v) => v,
        Err(e) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "bad_recipient",
                Some(e.to_string()),
            )
        }
    };
    let short = format!(
        "{}…",
        recipient.to_string().chars().take(10).collect::<String>()
    );
    let headers = match header_pairs(&headers) {
        Ok(h) => wire::strip_headers(&h),
        Err(e) => return json_error(StatusCode::BAD_REQUEST, "bad_headers", Some(e.to_string())),
    };
    let request = Request {
        v: 1,
        id: uuid::Uuid::new_v4().to_string(),
        method: method.to_string(),
        path: path.clone(),
        headers,
        body_b64: wire::encoded_body(&body),
    };
    if let Err(e) = wire::encode(&request) {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "frame_too_large",
            Some(e.to_string()),
        );
    }
    let mut client = state.client.lock().await;
    let opened = client.open_stream(recipient, None).await;
    drop(client);
    let mut stream = match opened {
        Ok(s) => s,
        Err(e) => {
            state.shared.errors.fetch_add(1, Ordering::Relaxed);
            return json_error(
                StatusCode::BAD_GATEWAY,
                "mixnet_open_failed",
                Some(e.to_string()),
            );
        }
    };
    let id = stream.id().to_string();
    let mut event = Event::new("request_sent", id.clone());
    event.recipient = Some(short.clone());
    event.method = Some(method.to_string());
    event.path = Some(path.clone());
    event.bytes_out = wire::encode(&request).ok().map(|v| v.len());
    event.header_names = Some(names(&request.headers));
    if let Err(e) = state.shared.events.push(event).await {
        eprintln!("tunnel event log: {e:#}");
    }
    let operation = async {
        let (ready, _): (wire::Ready, usize) = wire::read(&mut stream)
            .await
            .context("waiting for the gate's ready frame")?;
        if ready.v != 1 || !ready.ready {
            bail!("gate sent an invalid ready frame");
        }
        wire::write(&mut stream, &request).await?;
        let (response, bytes_in): (Response, usize) = wire::read(&mut stream).await?;
        if response.v != 1 || response.id != request.id {
            bail!("response version or request id mismatch");
        }
        Ok::<_, anyhow::Error>((response, bytes_in))
    };
    let (response, bytes_in) = match tokio::time::timeout(state.timeout, operation).await {
        Ok(Ok(value)) => value,
        Err(_) => {
            state.shared.errors.fetch_add(1, Ordering::Relaxed);
            let mut event = Event::new("error", id);
            event.recipient = Some(short);
            event.method = Some(method.to_string());
            event.path = Some(path);
            event.ms = Some(started.elapsed().as_millis());
            let _ = state.shared.events.push(event).await;
            return AxumResponse::builder().status(StatusCode::GATEWAY_TIMEOUT).header("content-type", "application/json").body(Body::from(serde_json::json!({"error":"mixnet_timeout","ms":started.elapsed().as_millis()}).to_string())).unwrap();
        }
        Ok(Err(e)) => {
            state.shared.errors.fetch_add(1, Ordering::Relaxed);
            let mut event = Event::new("error", id);
            event.recipient = Some(short);
            event.method = Some(method.to_string());
            event.path = Some(path);
            event.ms = Some(started.elapsed().as_millis());
            let _ = state.shared.events.push(event).await;
            return json_error(StatusCode::BAD_GATEWAY, "mixnet_error", Some(e.to_string()));
        }
    };
    let mut event = Event::new("response_received", id.clone());
    event.recipient = Some(short);
    event.method = Some(method.to_string());
    event.path = Some(path);
    event.status = Some(response.status);
    event.bytes_in = Some(bytes_in);
    event.ms = Some(started.elapsed().as_millis());
    event.header_names = Some(names(&response.headers));
    let _ = state.shared.events.push(event).await;
    let body = match wire::decoded_body(&response.body_b64) {
        Ok(b) => b,
        Err(e) => {
            state.shared.errors.fetch_add(1, Ordering::Relaxed);
            return json_error(StatusCode::BAD_GATEWAY, "bad_response", Some(e.to_string()));
        }
    };
    match http_response(response.status, &response.headers, body) {
        Ok(mut http) => {
            http.headers_mut().insert(
                "x-oboro-mix-ms",
                HeaderValue::from_str(&started.elapsed().as_millis().to_string()).unwrap(),
            );
            http.headers_mut()
                .insert("x-oboro-stream", HeaderValue::from_str(&id).unwrap());
            state.shared.served.fetch_add(1, Ordering::Relaxed);
            http
        }
        Err(e) => {
            state.shared.errors.fetch_add(1, Ordering::Relaxed);
            json_error(StatusCode::BAD_GATEWAY, "bad_response", Some(e.to_string()))
        }
    }
}
pub async fn run_tunnel(
    data: PathBuf,
    listen: SocketAddr,
    nym_env: Option<PathBuf>,
    timeout: Duration,
) -> Result<()> {
    let client = connect_persistent(&data, nym_env.as_deref()).await?;
    run_tunnel_with_client(client, data, listen, timeout).await
}
async fn tunnel_status(State(s): State<Arc<TunnelState>>) -> Json<Status> {
    status(State(s.shared.clone())).await
}
async fn tunnel_events(
    State(s): State<Arc<TunnelState>>,
    Query(q): Query<Since>,
) -> Json<Vec<Event>> {
    events(State(s.shared.clone()), Query(q)).await
}

pub async fn run_tunnel_with_client(
    client: MixnetClient,
    data: PathBuf,
    listen: SocketAddr,
    timeout: Duration,
) -> Result<()> {
    let address = client.nym_address().to_string();
    let events = Events::new(&data).await?;
    let shared = Shared::new("tunnel", address.clone(), None, events);
    let tunnel = Arc::new(TunnelState {
        client: Mutex::new(client),
        shared: shared.clone(),
        timeout,
    });
    let app = Router::new()
        .route("/status", get(tunnel_status))
        .route("/events", get(tunnel_events))
        .route("/nym/{recipient}/", any(tunnel_request))
        .route("/nym/{recipient}/{*path}", any(tunnel_request))
        .layer(DefaultBodyLimit::max(wire::MAX_FRAME))
        .with_state(tunnel);
    let listener = TcpListener::bind(listen)
        .await
        .context("bind tunnel listener")?;
    println!(
        "{}",
        serde_json::json!({"event":"ready","role":"tunnel","nymAddress":address})
    );
    axum::serve(listener, app).await.context("serve tunnel")
}

pub async fn probe(to: Recipient, data: Option<PathBuf>) -> Result<(u16, u128)> {
    let mut client = if let Some(dir) = data {
        connect_persistent(&dir, None).await?
    } else {
        MixnetClient::connect_new()
            .await
            .context("connect ephemeral probe")?
    };
    let started = Instant::now();
    let mut stream = client
        .open_stream(to, None)
        .await
        .context("open probe stream")?;
    let req = Request {
        v: 1,
        id: uuid::Uuid::new_v4().to_string(),
        method: "GET".into(),
        path: "/oboro/ping".into(),
        headers: vec![],
        body_b64: String::new(),
    };
    let (ready, _): (wire::Ready, usize) =
        tokio::time::timeout(Duration::from_secs(120), wire::read(&mut stream))
            .await
            .context("probe: no ready frame from the gate")??;
    if !ready.ready {
        bail!("probe: invalid ready frame");
    }
    wire::write(&mut stream, &req).await?;
    let (response, _): (Response, usize) =
        tokio::time::timeout(Duration::from_secs(180), wire::read(&mut stream))
            .await
            .context("probe timeout")??;
    if response.id != req.id || response.v != 1 {
        bail!("invalid probe response");
    }
    let ms = started.elapsed().as_millis();
    drop(stream);
    client.disconnect().await;
    Ok((response.status, ms))
}
