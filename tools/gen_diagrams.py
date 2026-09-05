# -*- coding: utf-8 -*-
"""从 docs/diagrams.json 生成架构图 / 时序图 / 流程图 PNG。

运行: python tools/gen_diagrams.py [spec_path]
默认读 docs/diagrams.json，输出到 spec 的 out_dir（缺省 ../docs 相对本文件）。
"""
import json
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei']
plt.rcParams['axes.unicode_minus'] = False

C_BOX = '#4A90D9'      # 模块框
C_BOX_NEW = '#2F855A'  # 新增模块强调
C_EDGE = '#666666'
C_TEXT = 'white'


def _save(fig, path):
    fig.savefig(path, dpi=160, bbox_inches='tight', facecolor='white')
    plt.close(fig)
    print('OK', path)


def draw_architecture(spec):
    fig, ax = plt.subplots(figsize=(14, 10))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.text(0.5, 0.97, spec['title'], ha='center', fontsize=17, fontweight='bold')
    ax.text(0.5, 0.935, spec['subtitle'], ha='center', fontsize=10, color='#555')

    layers = spec['layers']
    top, bot = 0.90, 0.06
    h = (top - bot) / len(layers)
    for i, layer in enumerate(layers):
        y1 = top - i * h
        y0 = y1 - h + 0.02
        ax.add_patch(FancyBboxPatch((0.02, y0), 0.96, h - 0.03,
                                    boxstyle='round,pad=0.005', fc='#F0F4F8',
                                    ec='#B0C4D4', lw=1.2))
        ax.text(0.035, y1 - 0.025, layer['title'], fontsize=12, fontweight='bold', color='#1F4E79')
        ax.text(0.035, y1 - 0.052, layer['subtitle'], fontsize=8.5, color='#667')

        mods = layer['modules']
        mw = 0.9 / len(mods)
        for j, m in enumerate(mods):
            x = 0.06 + j * mw
            cy = (y0 + y1) / 2 - 0.005
            color = C_BOX_NEW if m.get('status') == 'new' else C_BOX
            ax.add_patch(FancyBboxPatch((x, cy - 0.045), mw - 0.025, 0.09,
                                        boxstyle='round,pad=0.006', fc=color, ec='none'))
            for k, line in enumerate(m['lines']):
                ax.text(x + (mw - 0.025) / 2, cy + 0.028 - k * 0.024, line,
                        ha='center', va='center', fontsize=7.6, color=C_TEXT)

    for a in spec.get('annotations', []):
        (fx, fy), (tx, ty) = a['from'], a['to']
        ax.add_patch(FancyArrowPatch((fx, fy), (tx, ty),
                                     arrowstyle='-|>', mutation_scale=16,
                                     color=C_EDGE, lw=1.4))
        lx, ly = a.get('label_xy', [0.5, 0.5])
        ax.text(lx, ly, a['label'], ha='center', fontsize=8.5, color='#333',
                bbox=dict(fc='white', ec='none', pad=1.5))
    _save(fig, os.path.join(spec['out_dir'], spec['file']))


def draw_sequence(spec):
    parts = spec['participants']
    n = len(parts)
    fig, ax = plt.subplots(figsize=(13, 12))
    W = 1.0
    xs = [W * (i + 0.5) / n for i in range(n)]
    ax.set_xlim(0, W); ax.set_ylim(0, 1); ax.axis('off')
    ax.text(0.5, 0.975, spec['title'], ha='center', fontsize=15, fontweight='bold')

    top, bot = 0.93, 0.04
    for x, name in zip(xs, parts):
        ax.plot([x, x], [bot, top - 0.03], color='#AAAAAA', lw=1, ls='--', zorder=1)
        ax.add_patch(FancyBboxPatch((x - 0.09, top - 0.03), 0.18, 0.035,
                                    boxstyle='round,pad=0.004', fc='#1F4E79', ec='none'))
        ax.text(x, top - 0.012, name, ha='center', va='center', fontsize=9.5,
                color=C_TEXT, fontweight='bold')

    step = (top - 0.07 - bot) / len(spec['messages'])
    y = top - 0.07
    for i, (src, dst, msg) in enumerate(spec['messages']):
        y -= step
        if src == dst:
            ax.annotate('', xy=(xs[src] + 0.07, y - step * 0.4), xytext=(xs[src], y),
                        arrowprops=dict(arrowstyle='-|>', color=C_EDGE, lw=1.2))
            ax.text(xs[src] + 0.075, y - step * 0.2, msg, fontsize=8, va='center', color='#333')
        else:
            x0, x1 = xs[src], xs[dst]
            ax.add_patch(FancyArrowPatch((x0, y), (x1, y), arrowstyle='-|>',
                                         mutation_scale=14, color='#2F6DB5', lw=1.3))
            ax.text((x0 + x1) / 2, y + 0.008, msg, ha='center', fontsize=8, color='#333',
                    bbox=dict(fc='white', ec='none', pad=1))
    _save(fig, os.path.join(spec['out_dir'], spec['file']))


def draw_flowchart(spec):
    nodes = spec['nodes']      # {id: [label, x, y, kind]}
    edges = spec['edges']      # [from, to, label]
    fig, ax = plt.subplots(figsize=(13, 14))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.text(0.5, 0.98, spec['title'], ha='center', fontsize=15, fontweight='bold')

    style = {
        'start': dict(fc='#2F855A', shape='round'),
        'proc': dict(fc='#4A90D9', shape='round'),
        'dec': dict(fc='#B7791F', shape='diamond'),
        'io': dict(fc='#6B46C1', shape='round'),
        'end': dict(fc='#1F4E79', shape='round'),
    }
    pos = {}
    for nid, (label, x, y, kind) in nodes.items():
        pos[nid] = (x, y)
        st = style.get(kind, style['proc'])
        if st['shape'] == 'diamond':
            ax.add_patch(plt.Polygon([(x - 0.085, y), (x, y + 0.032), (x + 0.085, y), (x, y - 0.032)],
                                     closed=True, fc=st['fc'], ec='none'))
        else:
            ax.add_patch(FancyBboxPatch((x - 0.10, y - 0.024), 0.20, 0.048,
                                        boxstyle='round,pad=0.006', fc=st['fc'], ec='none'))
        for k, line in enumerate(label.split('\n')):
            off = (len(label.split('\n')) - 1) * 0.011
            ax.text(x, y + off - k * 0.022, line, ha='center', va='center',
                    fontsize=8.2, color=C_TEXT)

    for src, dst, label in edges:
        (x0, y0), (x1, y1) = pos[src], pos[dst]
        ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle='-|>',
                                     mutation_scale=15, color=C_EDGE, lw=1.3,
                                     shrinkA=26, shrinkB=26))
        if label:
            ax.text((x0 + x1) / 2 + 0.012, (y0 + y1) / 2, label, fontsize=8, color='#B00020',
                    bbox=dict(fc='white', ec='none', pad=1))
    _save(fig, os.path.join(spec['out_dir'], spec['file']))


def main():
    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), '..', 'docs', 'diagrams.json')
    with open(spec_path, encoding='utf-8') as f:
        spec = json.load(f)
    out = spec.get('out_dir') or os.path.join(os.path.dirname(spec_path), '')
    os.makedirs(out, exist_ok=True)

    arch = dict(spec['architecture'], out_dir=out)
    draw_architecture(arch)
    for s in spec.get('sequences', []):
        draw_sequence(dict(s, out_dir=out))
    for s in spec.get('flowcharts', []):
        draw_flowchart(dict(s, out_dir=out))


if __name__ == '__main__':
    main()
