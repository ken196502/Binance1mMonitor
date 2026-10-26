"""JSON-lines worker: batch first-touch simulation on Apple Metal (no CPU fallback).

Only training trajectories enter this process. Portfolio occupancy, float64 fills,
validation and holdout accounting remain in the existing TypeScript engine.
"""
import json
import signal
import sys
import time

import numpy as np
import torch


def first_exits(windows, parameters, device, signal_batch=1024):
    """Return [parameter,signal] offsets; -1 requires exact scalar replay.

    windows [signal,minute,5] stores entry-normalized O/H/L/C and contiguous
    validity. Missing bars terminate a path, even if later data is available.
    """
    count, horizon, _ = windows.shape
    result = np.empty((len(parameters), count), dtype=np.int32)
    stops = torch.tensor([1 + p['stopLossPercent'] / 100 for p in parameters],
                         dtype=torch.float32, device=device)[:, None, None]
    targets = torch.tensor([1 - p['takeProfitPercent'] / 100 for p in parameters],
                           dtype=torch.float32, device=device)[:, None, None]
    holds = torch.tensor([p['holdMinutes'] for p in parameters],
                         dtype=torch.int32, device=device)[:, None, None]
    steps = torch.arange(horizon, dtype=torch.int32, device=device)[None, None, :]
    for start in range(0, count, signal_batch):
        x = torch.as_tensor(windows[start:start + signal_batch], device=device)
        opening, high, low = (x[None, :, :, i] for i in range(3))
        valid = x[None, :, :, 4] > 0
        within = steps < holds
        event = (~valid | (opening >= stops) | (opening <= targets)
                 | (high >= stops) | (low <= targets) | (steps == holds - 1)) & within
        offsets = torch.where(event, steps, horizon).amin(dim=2)
        # Roundoff must never change which trade fires first. Prices close to
        # either threshold before the exit are replayed in the scalar engine.
        near = ((opening - stops).abs() <= 2e-6) | ((opening - targets).abs() <= 2e-6)
        near |= ((high - stops).abs() <= 2e-6) | ((low - targets).abs() <= 2e-6)
        uncertain = (near & valid & within & (steps <= offsets[:, :, None])).any(dim=2)
        offsets = torch.where(uncertain, -1, offsets)
        result[:, start:start + x.shape[0]] = offsets.cpu().numpy()
    return result.tolist()


def two_stage_exits(windows, parameters, day_changes, device, taker_fee_bps=5.0, slippage_bps=2.0, signal_batch=1024):
    """Batch simulate two-stage adaptive dynamic exits on Apple Metal GPU.

    windows [signal, minute, 5]: O/H/L/C normalized to entry price 1.0, and validity.
    Returns per-parameter summary metrics: trades, wins, losses, winRate, netPnlPercent.
    """
    count, horizon, _ = windows.shape
    num_params = len(parameters)
    dc = torch.as_tensor(day_changes, dtype=torch.float32, device=device).clamp(min=10.0)

    exitX = torch.tensor([p['exitX'] for p in parameters], dtype=torch.float32, device=device)[:, None]
    exitN = torch.tensor([p['exitN'] for p in parameters], dtype=torch.float32, device=device)[:, None]
    exitM = torch.tensor([p['exitM'] for p in parameters], dtype=torch.float32, device=device)[:, None]
    holds = torch.tensor([p['holdMinutes'] for p in parameters], dtype=torch.int32, device=device)[:, None]

    # [num_params, count]
    sl1 = dc[None, :] / exitX / 100.0
    tp1 = dc[None, :] / exitX / 100.0
    sl2 = dc[None, :] * exitN / exitX / 100.0
    tp2 = dc[None, :] * exitM / exitX / 100.0

    stops1 = 1.0 + sl1
    targets1 = 1.0 - tp1
    stops2 = 1.0 + sl2
    targets2 = 1.0 - tp2

    steps = torch.arange(horizon, dtype=torch.int32, device=device)[None, None, :]

    fee_rate = taker_fee_bps / 10000.0
    slip_rate = slippage_bps / 10000.0

    all_net_pnls = torch.zeros((num_params, count), dtype=torch.float32, device=device)

    for start in range(0, count, signal_batch):
        batch_slice = slice(start, start + signal_batch)
        x = torch.as_tensor(windows[batch_slice], device=device)
        b_count = x.shape[0]

        op = x[None, :, :, 0]
        hi = x[None, :, :, 1]
        lo = x[None, :, :, 2]
        cl = x[None, :, :, 3]
        valid = x[None, :, :, 4] > 0

        h_b = holds[:, :, None]
        within = steps < h_b

        st1 = stops1[:, batch_slice, None]
        tg1 = targets1[:, batch_slice, None]
        st2 = stops2[:, batch_slice, None]
        tg2 = targets2[:, batch_slice, None]

        # Stage 1 touch
        event1 = (~valid | (op >= st1) | (op <= tg1) | (hi >= st1) | (lo <= tg1) | (steps == h_b - 1)) & within
        off1 = torch.where(event1, steps, horizon).amin(dim=2)

        # Stage 1 price
        gather_idx = off1.clamp(max=horizon - 1)[:, :, None]
        op1 = torch.gather(op.expand(num_params, -1, -1), 2, gather_idx).squeeze(2)
        hi1 = torch.gather(hi.expand(num_params, -1, -1), 2, gather_idx).squeeze(2)
        lo1 = torch.gather(lo.expand(num_params, -1, -1), 2, gather_idx).squeeze(2)
        cl1 = torch.gather(cl.expand(num_params, -1, -1), 2, gather_idx).squeeze(2)

        st1_2d = st1.squeeze(2)
        tg1_2d = tg1.squeeze(2)

        exit1 = torch.where(op1 >= st1_2d, op1,
                torch.where(op1 <= tg1_2d, op1,
                torch.where(hi1 >= st1_2d, st1_2d,
                torch.where(lo1 <= tg1_2d, tg1_2d, cl1))))

        # Stage 2 touch (from off1 onwards)
        after1 = steps >= off1[:, :, None]
        event2 = (~valid | (op >= st2) | (op <= tg2) | (hi >= st2) | (lo <= tg2) | (steps == h_b - 1)) & within & after1
        off2 = torch.where(event2, steps, horizon).amin(dim=2)

        gather_idx2 = off2.clamp(max=horizon - 1)[:, :, None]
        op2 = torch.gather(op.expand(num_params, -1, -1), 2, gather_idx2).squeeze(2)
        hi2 = torch.gather(hi.expand(num_params, -1, -1), 2, gather_idx2).squeeze(2)
        lo2 = torch.gather(lo.expand(num_params, -1, -1), 2, gather_idx2).squeeze(2)
        cl2 = torch.gather(cl.expand(num_params, -1, -1), 2, gather_idx2).squeeze(2)

        st2_2d = st2.squeeze(2)
        tg2_2d = tg2.squeeze(2)

        exit2 = torch.where(op2 >= st2_2d, op2,
                torch.where(op2 <= tg2_2d, op2,
                torch.where(hi2 >= st2_2d, st2_2d,
                torch.where(lo2 <= tg2_2d, tg2_2d, cl2))))

        gross1 = (1.0 - exit1) * 100.0
        costs1 = (fee_rate + fee_rate * exit1 + slip_rate * (1.0 + exit1)) * 100.0
        net1 = gross1 - costs1

        gross2 = (1.0 - exit2) * 100.0
        costs2 = (fee_rate + fee_rate * exit2 + slip_rate * (1.0 + exit2)) * 100.0
        net2 = gross2 - costs2

        total_net = 0.5 * net1 + 0.5 * net2
        all_net_pnls[:, batch_slice] = total_net

    # Calculate metrics
    wins = (all_net_pnls > 0).sum(dim=1).cpu().numpy().tolist()
    losses = (all_net_pnls < 0).sum(dim=1).cpu().numpy().tolist()
    total_net = all_net_pnls.sum(dim=1).cpu().numpy().tolist()
    trades = count

    metrics = []
    for i in range(num_params):
        w = wins[i]
        l = losses[i]
        t = w + l
        wr = (w / t * 100.0) if t > 0 else 0.0
        metrics.append({
            'trades': trades,
            'wins': w,
            'losses': l,
            'winRate': wr,
            'netPnlPercent': total_net[i],
            'meanTradePercent': (total_net[i] / trades) if trades > 0 else 0.0,
        })

    return metrics


def serve():
    windows = device = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request['op'] == 'init':
                requested = request.get('device', 'mps')
                if requested not in ('mps', 'cpu'):
                    raise ValueError('device must be mps or cpu')
                if requested == 'mps' and not torch.backends.mps.is_available():
                    raise RuntimeError('Apple Metal/MPS unavailable; use native arm64 Python on Apple Silicon. No automatic CPU fallback.')
                device = torch.device(requested)
                # Execute a kernel before claiming the device is usable.
                probe = (torch.arange(32, device=device, dtype=torch.float32) ** 2).sum().item()
                if probe != 10416:
                    raise RuntimeError('device smoke test failed')
                shape = (request['signals'], request['horizon'], 5)
                windows = np.fromfile(request['file'], dtype='<f4').reshape(shape)
                response = {'device': str(device), 'torch': torch.__version__,
                            'signals': shape[0], 'horizon': shape[1], 'probe': probe}
            elif request['op'] == 'evaluate':
                if windows is None:
                    raise RuntimeError('init required')
                params = request['parameters']
                if not params or len(params) > 128:
                    raise ValueError('parameter batch must contain 1..128 entries')
                for p in params:
                    if not 1 <= p['holdMinutes'] <= windows.shape[1]:
                        raise ValueError('hold exceeds exported trajectories')
                began = time.perf_counter()
                offsets = first_exits(windows, params, device, request.get('signalBatch', 1024))
                if device.type == 'mps':
                    torch.mps.synchronize()
                response = {'offsets': offsets, 'seconds': time.perf_counter() - began}
            elif request['op'] == 'two_stage_evaluate':
                if windows is None:
                    raise RuntimeError('init required')
                params = request['parameters']
                day_changes = request['dayChanges']
                began = time.perf_counter()
                metrics = two_stage_exits(windows, params, day_changes, device,
                                          request.get('takerFeeBps', 5.0),
                                          request.get('slippageBps', 2.0),
                                          request.get('signalBatch', 1024))
                if device.type == 'mps':
                    torch.mps.synchronize()
                response = {'metrics': metrics, 'seconds': time.perf_counter() - began}
            else:
                raise ValueError('unknown operation')
            print(json.dumps({'ok': True, **response}, allow_nan=False), flush=True)
        except Exception as exc:
            print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}), flush=True)


if __name__ == '__main__':
    # The parent checkpoints the current round on Ctrl-C, then closes us.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    serve()
