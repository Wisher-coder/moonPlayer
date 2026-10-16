// ============================================================================
// 封面消费工具（ui 内部共享件，不属于跨模块契约的八原语）
// ----------------------------------------------------------------------------
// 三端 App 无同源概念：后端归一化数据里的 cover / avatar 可能是
// 「/api/img/...」相对地址，直接喂给 expo-image 会解析到设备本地路径而全部
// 裂图——必须先经跨模块契约 src/lib/client.js 的 absolutizeUrl(u) 绝对化
// （拼上 serverBase），再交给图片组件。
// 省流档：契约 settings.js 的 datasaver 键开启时，对本站图片代理路径
// （/api/img/*）追加 &w=320 宽度档（后端图片代理的 w 档缩放 + WebP，列表页
// 封面流量约省一半）——只对本站代理 URL 生效，外部 CDN 直链绝不乱拼参数
// （口径与 NextWeb src/lib/utils.js 的 coverSrc/COVER_SAVER_W 相同）。
// 分片轮询（lib/origin-pool.js）：服务端下发 telegram shardPorts 时，本站
// /api/img 代理地址按 URL 稳定 hash 轮询 origin（同图恒定、异图分散；相对
// 与基址绝对两种形态归一后取 hash，跨形态同图同 origin）。池未启用 / 非代理
// 地址 / 任何异常都保持原值，行为与现在完全一致。
import { useEffect, useState } from 'react';
import { absolutizeUrl } from '../../lib/client.js';
import { shardMediaUrl } from '../../lib/origin-pool.js';
import { getSettingsSnapshot, subscribeSettings } from '../../lib/settings.js';

// 省流档固定 320 宽：已覆盖全部展示位（缩略/头像）×2~3 DPR，最省字节且不糊
export const COVER_SAVER_W = 320;
// 本站图片代理路径标记：只有 /api/img/* 开头（相对）或含该段（绝对化后）
// 的地址才可带 w 档，外部直链不归我们的服务器管
const PROXY_MARK = '/api/img/';

// 封面/头像 URL 消费统一入口：绝对化 + 分片轮询 + 省流档收窄。
// 任何一步失败都原样返回入参（回退保证：省流只是档位选择，不改变可用性）
export function coverUrl(u, saver) {
  if (u == null || u === '') return u;
  let abs = u;
  try {
    abs = absolutizeUrl(u);
  } catch (_e) {
    abs = u; // 绝对化工具异常：退回原始地址，让图片层自行兜底占位
  }
  // 分片轮询：池启用时 /api/img 代理地址搬到 hash 命中的 origin；未启用/
  // 非代理地址返回 null 保持绝对化结果（注意用原始入参 u 参与归一，别把
  // 已绝对化的 abs 再喂一遍——shardPathOf 两种形态都认，但以 u 为准语义最稳）
  try {
    const sh = shardMediaUrl(u);
    if (sh) abs = sh;
  } catch (_e) {
    /* 分片层异常：保持绝对化结果 */
  }
  if (!saver || typeof abs !== 'string' || abs.indexOf(PROXY_MARK) < 0) return abs;
  return abs + (abs.indexOf('?') >= 0 ? '&' : '?') + 'w=' + COVER_SAVER_W;
}

// 省流开关订阅 hook：初值读同步快照 getSettingsSnapshot().datasaver（水合完成
// 前 snapshot 是默认值，水合完成的广播会推真值），之后跟随 subscribeSettings
// 广播（载荷 = 整份设置快照 {autoplay, datasaver, serverBase}，见 settings.js
// emit 实现；这里仍做单键对象形态的防御式兼容）。异常一律按关闭处理
export function useDataSaver() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let dead = false;
    // 读当前真值（失败按关闭）
    const read = () => {
      try {
        return !!(getSettingsSnapshot() || {}).datasaver;
      } catch (_e) {
        return false;
      }
    };
    setOn(read());
    // 订阅后续变化：返回的退订函数若存在则挂在 cleanup 上
    let off = null;
    try {
      off = subscribeSettings((payload) => {
        if (dead) return;
        let v;
        if (payload && typeof payload === 'object') {
          // 单键广播 {key:'datasaver', value} 或整份对象 {datasaver}
          v = payload.key === 'datasaver' ? payload.value : payload.datasaver;
        }
        if (v === undefined) v = read(); // 载荷不含该键：现读快照
        if (v != null) setOn(!!v);
      });
    } catch (_e) {
      // 订阅通道异常：保持快照值（开关仍是运行期可读的持久化键）
    }
    return () => {
      dead = true;
      if (typeof off === 'function') off();
    };
  }, []);
  return on;
}
