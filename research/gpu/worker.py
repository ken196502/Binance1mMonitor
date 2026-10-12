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
            else:
                raise ValueError('unknown operation')
            print(json.dumps({'ok': True, **response}, allow_nan=False), flush=True)
        except Exception as exc:
            print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}), flush=True)


if __name__ == '__main__':
    # The parent checkpoints the current round on Ctrl-C, then closes us.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    serve()
