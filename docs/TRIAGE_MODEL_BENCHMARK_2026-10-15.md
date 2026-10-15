# Local Ollama triage benchmark

Generated: 2026-10-15T22:41:36.751Z
Endpoint: http://127.0.0.1:11434
Dataset size: 15
Execution: sequential requests, CPU forced with `num_gpu: 0`; latency includes HTTP/model response time.
Memory: `size` and `size_vram` are Ollama resident model measurements from `/api/ps`, when available. `size` is model footprint, not process RSS.

| Model | Accuracy | Mean latency | Median | P95 | Mean output tok/s | Model bytes | VRAM bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| qwen2.5-coder:7b | 86.7% | 3487.5 ms | 2777.5 ms | 13481.7 ms | 8.0 | 4950379724 | 0 |
| qwen3:4b | 73.3% | 2839.6 ms | 2338.0 ms | 9376.5 ms | 12.6 | 2882021620 | 0 |
| qwen3:1.7b | 73.3% | 1284.5 ms | 1044.2 ms | 4480.0 ms | 26.4 | 1649651219 | 0 |

## Per message

| Model | ID | Expected | Predicted | Correct | Latency ms | Output tokens | tok/s | Error |
|---|---|---|---|---:|---:|---:|---:|---|
| qwen2.5-coder:7b | urgent-bank-login | urgent | urgent | yes | 13481.7 | 18 | 8.1 |  |
| qwen2.5-coder:7b | urgent-prescription | urgent | routine | no | 3037.5 | 18 | 8.2 |  |
| qwen2.5-coder:7b | urgent-school-pickup | urgent | routine | no | 4109.9 | 24 | 7.8 |  |
| qwen2.5-coder:7b | urgent-water-leak | urgent | urgent | yes | 2301.4 | 13 | 8.3 |  |
| qwen2.5-coder:7b | urgent-account-lock | urgent | urgent | yes | 2398.8 | 13 | 8.3 |  |
| qwen2.5-coder:7b | routine-water-bill | routine | routine | yes | 2827.2 | 15 | 8.0 |  |
| qwen2.5-coder:7b | routine-meeting | routine | routine | yes | 2739.5 | 15 | 8.0 |  |
| qwen2.5-coder:7b | routine-package | routine | routine | yes | 2986.0 | 16 | 8.0 |  |
| qwen2.5-coder:7b | routine-school-form | routine | routine | yes | 2574.7 | 14 | 8.1 |  |
| qwen2.5-coder:7b | routine-renewal | routine | routine | yes | 2496.3 | 15 | 8.1 |  |
| qwen2.5-coder:7b | noise-promo | noise | noise | yes | 2873.5 | 16 | 8.0 |  |
| qwen2.5-coder:7b | noise-weather | noise | noise | yes | 2777.5 | 15 | 8.0 |  |
| qwen2.5-coder:7b | noise-social | noise | noise | yes | 2165.7 | 12 | 8.2 |  |
| qwen2.5-coder:7b | noise-game | noise | noise | yes | 2719.1 | 16 | 8.0 |  |
| qwen2.5-coder:7b | noise-news | noise | noise | yes | 2823.4 | 15 | 7.6 |  |
| qwen3:4b | urgent-bank-login | urgent | urgent | yes | 9376.5 | 19 | 12.3 |  |
| qwen3:4b | urgent-prescription | urgent | urgent | yes | 2255.7 | 20 | 12.7 |  |
| qwen3:4b | urgent-school-pickup | urgent | routine | no | 2552.4 | 23 | 12.5 |  |
| qwen3:4b | urgent-water-leak | urgent | urgent | yes | 1994.4 | 19 | 12.8 |  |
| qwen3:4b | urgent-account-lock | urgent | urgent | yes | 2225.6 | 21 | 12.8 |  |
| qwen3:4b | routine-water-bill | routine | routine | yes | 2805.3 | 26 | 12.3 |  |
| qwen3:4b | routine-meeting | routine | routine | yes | 2450.6 | 23 | 12.7 |  |
| qwen3:4b | routine-package | routine | routine | yes | 2613.7 | 23 | 12.0 |  |
| qwen3:4b | routine-school-form | routine | routine | yes | 2326.3 | 22 | 12.7 |  |
| qwen3:4b | routine-renewal | routine | routine | yes | 2105.2 | 20 | 12.8 |  |
| qwen3:4b | noise-promo | noise | noise | yes | 2372.4 | 22 | 12.5 |  |
| qwen3:4b | noise-weather | noise | routine | no | 2319.9 | 22 | 12.7 |  |
| qwen3:4b | noise-social | noise | noise | yes | 2288.6 | 23 | 12.8 |  |
| qwen3:4b | noise-game | noise | routine | no | 2338.0 | 24 | 12.7 |  |
| qwen3:4b | noise-news | noise | routine | no | 2568.9 | 26 | 12.9 |  |
| qwen3:1.7b | urgent-bank-login | urgent | urgent | yes | 4480.0 | 17 | 25.3 |  |
| qwen3:1.7b | urgent-prescription | urgent | urgent | yes | 961.0 | 17 | 26.6 |  |
| qwen3:1.7b | urgent-school-pickup | urgent | urgent | yes | 1025.3 | 18 | 26.6 |  |
| qwen3:1.7b | urgent-water-leak | urgent | urgent | yes | 1044.2 | 20 | 26.0 |  |
| qwen3:1.7b | urgent-account-lock | urgent | urgent | yes | 967.4 | 18 | 26.8 |  |
| qwen3:1.7b | routine-water-bill | routine | urgent | no | 1001.6 | 18 | 27.1 |  |
| qwen3:1.7b | routine-meeting | routine | routine | yes | 1086.1 | 21 | 26.9 |  |
| qwen3:1.7b | routine-package | routine | routine | yes | 1148.3 | 22 | 26.8 |  |
| qwen3:1.7b | routine-school-form | routine | routine | yes | 1033.4 | 19 | 26.6 |  |
| qwen3:1.7b | routine-renewal | routine | routine | yes | 907.4 | 17 | 26.5 |  |
| qwen3:1.7b | noise-promo | noise | routine | no | 1134.0 | 21 | 25.6 |  |
| qwen3:1.7b | noise-weather | noise | routine | no | 1274.2 | 25 | 26.0 |  |
| qwen3:1.7b | noise-social | noise | noise | yes | 925.5 | 18 | 26.7 |  |
| qwen3:1.7b | noise-game | noise | routine | no | 1074.2 | 22 | 26.9 |  |
| qwen3:1.7b | noise-news | noise | noise | yes | 1204.7 | 24 | 25.7 |  |
