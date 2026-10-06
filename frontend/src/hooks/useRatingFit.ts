/**
 * useRatingFit：水位流量点据按涨落支分组拟合、残差与绳套曲线状态管理。
 * 被关系点据页与导出页消费；点据数据来自 ratingStore（IndexedDB 实时订阅）。
 * 同一测站的点据按态势分为涨水支、落水支，分别拟合幂函数曲线。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  buildBranchFits,
  curveFlow,
  type Rating,
  type RatingFitResult,
  type TrendLabel
} from '@/types/rating'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 所属支线（涨水支 / 落水支）曲线流量 */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  fit: RatingFitResult | null
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前定线号下各支线（测站 × 涨落）的拟合结果 */
  fits: ComputedRef<RatingFitResult[]>
  /** 全量支线拟合结果 */
  allFits: ComputedRef<RatingFitResult[]>
  /** 当前定线号的点据（含所属支线残差） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 按最新点据重算各支线定线参数并刷新比测 */
  refit: () => Promise<{ count: number; fits: RatingFitResult[] }>
}

/**
 * 组合式函数：按定线号 × 涨落支分组拟合幂函数 Q = a×(H-H0)^b，并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => {
    const station = ratingStore.stations.find((item) => item.id === stationId)
    return station ? station.name : '未知测站'
  }

  /** 全量支线拟合：测站 × 定线号 × 涨落态势 */
  const allFits = computed<RatingFitResult[]>(() => buildBranchFits(ratings.value))

  const fits = computed<RatingFitResult[]>(() =>
    allFits.value.filter((fit) => fit.lineNo === activeLineNo.value)
  )

  const pointRows = computed<RatingPointRow[]>(() => {
    const currentFits = allFits.value
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt))
      .map((rating) => {
        const trend: TrendLabel = rating.trend === '落水' ? '落水' : '涨水'
        const current = ratingStore.branchFitOf(rating, currentFits) ?? null
        const predicted = current && current.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current && current.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          curveFlowM3s: predicted,
          residualPct,
          fit: current
        }
      })
  })

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return allFits.value
      .filter((fit) => fit.valid)
      .flatMap((fit) =>
        ratings.value
          .filter(
            (rating) =>
              rating.stationId === fit.stationId &&
              rating.lineNo === fit.lineNo &&
              (rating.trend === '落水' ? '落水' : '涨水') === fit.trend
          )
          .map((rating) => {
            const predicted = curveFlow(fit, rating.stageM)
            const residualPct =
              rating.flowM3s > 0
                ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
                : 0
            return {
              rating,
              stationName: stationNameOf(rating.stationId),
              curveFlowM3s: predicted,
              residualPct,
              fit
            }
          })
          .filter((row) => Math.abs(row.residualPct) > limit)
      )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function refit(): Promise<{ count: number; fits: RatingFitResult[] }> {
    return ratingStore.rebuildCompares(activeLineNo.value)
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    fits,
    allFits,
    pointRows,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
