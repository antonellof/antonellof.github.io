---
layout: post
title: "Laya Trader: a small local model paper-trading crypto and S&P 500 stocks"
date: 2026-09-25
categories: [Projects]
tags: [AI, MLX, PyTorch, Laya, Local Inference, Trading, Backtesting, Python, Hugging Face]
excerpt: "Laya Trader asks a small typed-decision model one question about 11 assets: is the short-term outlook bullish? A strategy turns each answer into a paper trade. Stocks kept up with buy and hold on some names and lost far less in bad months. Crypto lost money in a rising month. Every trade, prompt and backtest runs on a live dashboard on Hugging Face."
---

![Laya Trader live dashboard: 3 coins and 8 stocks, with P(bullish), action and paper equity per asset](/assets/images/posts/laya-trader-live.png)

When I want a model to make a decision, my first reflex is a chat model. I write a prompt, the model generates text, and I parse a JSON answer out of the text. For a single yes or no, I pay for hundreds of generated tokens and hope the format holds.

Jev, a hosted API from TypeSafe, works differently. You send a state and a question with a fixed type: a choice between options, a score on a scale, or a yes/no. Jev returns probabilities. Nothing gets generated, and nothing needs parsing.

[Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations is an open, Jev-compatible model under Apache 2.0. Under the hood sits a BERT-style encoder (the multilingual checkpoint uses mmBERT-base, 322M parameters), trained with reinforcement learning to return calibrated probabilities. One bidirectional forward pass reads the state and the question together. The project reports a median of 32.8 ms per question, against 236 to 276 ms in third-party measurements of Jev. [laya-mlx](https://github.com/mizorewww/laya-mlx) ports Laya to Apple Silicon, where a short question takes about 15 ms on my M2 Pro.

A yes/no question answered with a probability looks a lot like a trading signal. I built [Laya Trader](https://github.com/antonellof/laya-trader) to test the idea.

The trader reads market signals for 3 coins (BTC, ETH, SOL) and 8 large S&P 500 stocks (AAPL, MSFT, NVDA, AMZN, GOOGL, META, JPM, XOM). For each asset, Laya answers one question: "Is the short-term outlook for this asset bullish?" The answer comes back as a probability between 0 and 1. A strategy turns the probability into LONG, SHORT, CLOSE or HOLD on a paper account with 1,000 USD per asset.

No API keys. No orders reach an exchange or a broker. The results below include the losses, and none of this is financial advice.

The dashboard runs live on [Hugging Face Spaces](https://huggingface.co/spaces/antonellof/laya-trader). Open the page and you see every decision as Laya makes one.

## What Laya reads

Laya sees one sentence per asset, so the real work goes into writing the sentence.

Each round, the trader pulls public data. Crypto candles, futures statistics and order flow come from Binance, plus the Fear & Greed index. Stock candles come from Yahoo Finance during the US session, with VIX and SPY for context. The code turns the candles into RSI, MACD, EMA trend, volatility, volume, 4h momentum and daily support and resistance. Then the signals become words.

Here is a real crypto request, exactly as the dashboard logged the call:

![The exact request sent to Laya, and the 309 tokens the encoder read](/assets/images/posts/laya-trader-prompt.png)

Stocks get a much shorter state:

```
Stock market signals. Good: trend votes bullish (+3 of 4), price above EMA20,
MACD positive, MACD rising. No earlier trades on this asset.
```

The difference comes from tests. On crypto, adding the raw indicator values and a detailed memory of past trades moved 9 unseen months from +12.1% to +26.1%, and the worst drawdown shrank from −17.1% to −10.2%. On stocks, the same additions dropped the result from +11.5% to +1.1%. Laya turned cautious and sat out most moves. Time in the market fell from 66% to 33%.

Click any row in the decision log and you get the rule behind the action, every signal, the request, the tokens the encoder read and the raw answer. I wanted to see why each trade happened without reading code.

## From a probability to a trade

Crypto follows the signal. P at or above 0.65 opens a long, P at or below 0.20 opens a short on Binance USD-M futures, at 1x. The trader only takes trades in the direction of the 4h trend. Each entry gets a stop 4 ATR away, positions close after 70 hourly candles (about 3 days), and a 2 hour cooldown separates trades.

Stocks buy the dip. A low P counts as oversold, and the trader goes long. The position closes when the signal flips. No stop, no shorts, 1 hour cooldown.

The stock rule came out of a prompt lab. I scored 10 prompts (5 questions, 2 wordings) by how well P predicted the next 4 hours. On stocks, a low P came before a bounce in both halves of the data, with a gap of 36 basis points between the top and bottom fifth of P. Stock fees here cost about 4. On crypto the relation changed sign between the two halves. None of the 9 alternative prompts beat the original question.

## The first version lost 27% in a month

My first 30-day crypto run traded 15-minute candles with tight stops and a 15-minute cooldown. BTC lost 26.7%, ETH 17.7%, SOL 11.7%. Buy and hold made between 7% and 19% over the same days.

Taking the trades apart showed three problems:

- Fees. BTC made 148 round trips in one month, and fees ate about 255 of the coin's 1,000 USD.
- Stops placed 1.5 ATR under a dip fired at the low. Stop exits lost 250 to 310 USD per coin, while exits on a signal flip made money on all three coins.
- No trend filter, so the strategy kept betting against a market drifting up.

From then on, every change had to pass the same test. Pick settings on older data. Run them on months the search never saw.

## What held up on unseen months

`walkforward.py --rolling` picks a strategy on 90 days, tests on the next 30, then slides forward one month. I ran everything on hourly candles.

Stocks, 20 names, 20 test months including the April 2025 tariff selloff:

- No stop made +19.6%. Buy and hold made +25.7%.
- Every stop variant did worse, between +13.5% and +16.6%. Stops sold dips at the low and missed the rebound the strategy buys them for.
- The worst drawdown on a single stock was −28.9% against −41.5% for holding. The biggest single losses came from overnight gaps after news, where no price stop helps.

Crypto, 9 test months where buy and hold lost 8.7%:

- The old 15-minute setup: −27.4%.
- Hourly candles, trades only with the 4h trend, a 3-day limit and a 4 ATR stop: +0.5%.
- Futures at 1x with a 2 hour cooldown and 1.5% risk per trade: +6.4%.
- Detailed wording plus memory on top: +26.1%, worst month −4.4%.
- 2x leverage lost 17.5%. 3x lost 35.3%.

One result hurt. On crypto, the plain indicator votes beat Laya on the same structure, +8.6% against +0.5%, before the wording and memory changes. The prompt lab had already warned me about the unstable crypto signal.

Single numbers move a lot. The same futures setup made +6.4% in one run and +12.1% in a run a few hours later, where the only change was a test window starting a few hours later. Trust the order between variants. Ignore the decimals.

## The last 30 days

![Backtest report on the Hugging Face Space: 30 days to 25 September 2026, each asset against rules only and buy and hold](/assets/images/posts/laya-trader-backtest.png)

The Space rebuilt the 30-day backtest this morning on the Space's own CPU:

| Asset | Laya | Buy and hold |
|---|---:|---:|
| BTC | −5.0% | +8.1% |
| ETH | −1.0% | +10.5% |
| SOL | −0.3% | +22.8% |
| NVDA | +7.5% | +2.0% |
| XOM | +7.0% | +3.8% |
| MSFT | +0.9% | −3.6% |
| AMZN | −3.8% | −6.2% |
| META | +0.1% | +35.2% |

Crypto lost money in a month where holding made 8% to 23%. Stocks did better: Laya beat buy and hold on 6 of the 8 names.

NVIDIA is the clearest win. Holding NVDA for the 30 days made +2.0%, with a drawdown of −10.3% along the way. The plain indicator rules lost 1.9%. Laya made +7.5% with a worst drawdown of −0.8%.

![NVDA backtest detail on the Space: price with Laya's entries and exits, P(bullish) over time, and the return curves of Laya, rules only and buy and hold](/assets/images/posts/laya-trader-nvda.png)

Laya bought NVDA 5 times and closed all 5 trades in profit. Each entry followed a low P, each exit a flip to a high one:

- 1 September: bought at 217.46 with P at 0.16, sold the next day at 222.83 when P reached 0.66. +2.5%.
- 14 September: bought the dip at 210.46 (P 0.19), out 2 hours later at 211.79.
- 16 September: bought at 213.91 (P 0.21), sold on 18 September at 219.52 with P at 0.92. +2.6%.

Laya missed the run to 236 in early September. The account stayed flat from 2 to 14 September, through the rally and through the drop back to 210 afterwards. Buy and hold rode both. Dip buying pays when a stock swings inside a range, and NVDA swung between 210 and 236 all month.

META shows the other side of buying dips. The stock climbed 35%, and Laya made 0.1% on 2 trades while waiting for a dip.

The Mac run on MLX and the Linux run on PyTorch agree. Stock results matched to the decimal. Crypto differed by up to 2.2 points, mostly because the Space window ended an hour later.

## Running on Hugging Face for free

laya-mlx needs Apple Silicon. For the public demo I used the original PyTorch release of Laya with the same multilingual weights. On identical inputs, P matched MLX within 0.002.

Getting a free Space to run took a few fixes:

- Docker Spaces need a paid plan on my account. The free option was the Gradio SDK on ZeroGPU hardware. ZeroGPU only starts through Gradio's `launch()` and wants one `@spaces.GPU` function, so `app.py` launches a minimal Gradio app, runs the dashboard on an internal port and routes the pages through Gradio's server. Laya never touches the GPU.
- Binance blocks US servers with HTTP 451. Spot candles now come from Binance's public mirror at data-api.binance.vision. Futures statistics have no mirror, so the Space trades crypto without funding and open interest.
- The container reports 192 CPUs. PyTorch started 16 threads for the live loop and 16 more for the backtest, and they throttled each other. Halving the backtest threads and giving the backtest a lower priority took a Laya call from 480 ms to 340 ms.
- I tried int8 quantization. Slower on this CPU, and P moved by up to 0.38, enough to flip 3 of 11 decisions. Dropped.

The Space runs a round every 10 seconds and rebuilds the backtest every 24 hours. Nothing persists, so a restart resets the paper account.

## Run Laya Trader

You need an Apple Silicon Mac and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/antonellof/laya-trader
cd laya-trader
./run.sh
```

The dashboard opens at http://127.0.0.1:8765. The first run downloads the checkpoint, about 650 MB. On Linux the same code switches to the PyTorch runtime.

The research tools live next to the trader:

```bash
uv run python backtest.py --days 30        # replay history, compare with rules only and buy and hold
uv run python promptlab.py                 # score prompts by how well P predicts the next move
uv run python walkforward.py --rolling     # pick on older months, test on newer ones
./deploy_space.sh                          # publish your own copy (after hf auth login)
```

## Where I stand

Laya Trader never beat buy and hold over a long test. On 8 stocks over 6 months, the strategy made +13.1% against +21.4% for holding, with a worst drawdown of −16.1% against −24.2%. For a rule this simple, I find the trade reasonable. On crypto I have no case yet.

The method matters more to me than any single result. Every default in `config.toml` points to a test on unseen months, and many of my ideas died there: 1 and 15-minute candles, leverage, stops on stocks, re-picking the strategy every month, detailed memory on stocks. My best-looking early crypto strategy made +1.2% on 10 unseen days and then lost 27% to 31% over 9 months. If you build something similar, run a walk-forward test before you believe a profitable backtest.

## Links

- [Live demo on Hugging Face](https://huggingface.co/spaces/antonellof/laya-trader)
- [laya-trader on GitHub](https://github.com/antonellof/laya-trader), with [the design notes](https://github.com/antonellof/laya-trader/blob/main/docs/HOW-IT-WORKS.md) and [every experiment](https://github.com/antonellof/laya-trader/blob/main/docs/RESEARCH.md)
- [Laya vs Dijkstra](/2026/laya-vs-dijkstra-path-solving-mlx/), the maze experiment
- [laya-mlx](https://github.com/mizorewww/laya-mlx), the MLX port
- [Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations

## AI full disclosure

I built this project with strong assistance from Claude Code. I led the idea, the questions and the checks. Every number in this post comes from real runs on my Mac or on the Space. If you are not happy with AI-developed code, this project is not for you.
