use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    routing::any,
    Router,
};
use std::{
    net::{SocketAddr, TcpListener as StdListener},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

fn free_port() -> SocketAddr {
    let listener = StdListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

#[tokio::test]
#[ignore = "requires real Nym mainnet mixnet; run with cargo test --test live_roundtrip -- --ignored --nocapture"]
async fn live_roundtrip() -> anyhow::Result<()> {
    let gate_dir = tempfile::tempdir()?;
    let tunnel_dir = tempfile::tempdir()?;
    let seen = Arc::new(Mutex::new(Vec::<HeaderMap>::new()));
    let upstream = free_port();
    let app = Router::new()
        .fallback(any({
            move |State(seen): State<Arc<Mutex<Vec<HeaderMap>>>>,
                  uri: Uri,
                  headers: HeaderMap,
                  body: Bytes| async move {
                seen.lock().await.push(headers);
                match uri.path() {
                    "/paid" => (StatusCode::PAYMENT_REQUIRED, b"payment required".to_vec()),
                    "/echo" => (StatusCode::OK, body.to_vec()),
                    _ => (StatusCode::OK, br#"{"free":true}"#.to_vec()),
                }
            }
        }))
        .with_state(seen.clone());
    let upstream_listener = tokio::net::TcpListener::bind(upstream).await?;
    let upstream_task =
        tokio::spawn(async move { axum::serve(upstream_listener, app).await.unwrap() });

    let gate_client = oboro_node::connect_persistent(gate_dir.path(), None).await?;
    let gate_address = gate_client.nym_address().to_string();
    let gate_status = free_port();
    let gate_data = gate_dir.path().to_path_buf();
    let gate_task = tokio::spawn(async move {
        oboro_node::run_gate_with_client(
            gate_client,
            format!("http://{upstream}"),
            gate_data,
            gate_status,
        )
        .await
        .unwrap()
    });
    let tunnel_client = oboro_node::connect_persistent(tunnel_dir.path(), None).await?;
    let tunnel_listen = free_port();
    let tunnel_data = tunnel_dir.path().to_path_buf();
    let tunnel_task = tokio::spawn(async move {
        oboro_node::run_tunnel_with_client(
            tunnel_client,
            tunnel_data,
            tunnel_listen,
            Duration::from_secs(240),
        )
        .await
        .unwrap()
    });
    tokio::time::sleep(Duration::from_secs(2)).await;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    let base = format!("http://{tunnel_listen}/nym/{gate_address}");
    let start = Instant::now();
    let free = http.get(format!("{base}/free")).send().await?;
    let free_status = free.status();
    let free_body = free.bytes().await?;
    println!(
        "GET /free: status={free_status} ms={} body={}",
        start.elapsed().as_millis(),
        String::from_utf8_lossy(&free_body)
    );
    assert_eq!(free_status, StatusCode::OK);
    assert_eq!(&free_body[..], br#"{"free":true}"#);
    let start = Instant::now();
    let paid = http.get(format!("{base}/paid")).send().await?;
    let paid_status = paid.status();
    let paid_body = paid.bytes().await?;
    println!(
        "GET /paid: status={paid_status} ms={} body={}",
        start.elapsed().as_millis(),
        String::from_utf8_lossy(&paid_body)
    );
    assert_eq!(paid_status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(&paid_body[..], b"payment required");
    let payload = vec![b'Z'; 20 * 1024];
    let start = Instant::now();
    let echo = http
        .post(format!("{base}/echo"))
        .body(payload.clone())
        .send()
        .await?;
    let echo_status = echo.status();
    let echo_body = echo.bytes().await?;
    println!(
        "POST /echo: status={echo_status} ms={} bytes={}",
        start.elapsed().as_millis(),
        echo_body.len()
    );
    assert_eq!(echo_status, StatusCode::OK);
    assert_eq!(&echo_body[..], payload);
    let seen = seen.lock().await;
    assert_eq!(seen.len(), 3);
    for headers in seen.iter() {
        assert_eq!(headers.get("x-oboro-transport").unwrap(), "nym-mixnet");
        assert!(headers.get("x-forwarded-for").is_none());
        assert!(headers.get("x-real-ip").is_none());
        assert!(headers.get("forwarded").is_none());
    }
    tunnel_task.abort();
    gate_task.abort();
    upstream_task.abort();
    Ok(())
}
