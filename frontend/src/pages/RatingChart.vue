<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线
 * 同一测站按涨落态势分成涨水支 / 落水支分别幂函数拟合 Q = a×(H-H0)^b，
 * 关系曲线绘制两支并按绳套宽度标出同水位流量差，残差超限点据挂红并进入比测分析清单。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import {
  curveFlow,
  RISE_FALL_LABELS,
  suggestRiseFall,
  type Rating,
  type RatingFitResult,
  type RiseFall
} from '@/types/rating'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
/** 涨落态势是否被定线人员手动改过：改过之后不再自动刷新建议标识 */
const riseFallTouched = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  riseFall: 'rising' as RiseFall,
  riseFallManual: false,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))
const branchFits = computed(() => ratingStore.activeBranchFits)
const risingFit = computed(() => branchFits.value.rising)
const fallingFit = computed(() => branchFits.value.falling)

/** 当前定线号下的点据（含所属支线曲线流量与残差） */
const pointRows = computed(() =>
  ratingStore.pointRows.map((row) => {
    const compare = ratingStore.compares.find((item) => item.ratingId === row.rating.id)
    return {
      ...row,
      stationName: ratingStore.stationNameOf(row.rating.stationId),
      verdict: compare?.verdict ?? (Math.abs(row.residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
    }
  })
)

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 绳套宽度：同一水位两支曲线的流量差 */
const loopWidth = computed(() => {
  const rising = risingFit.value
  const falling = fallingFit.value
  const rows = pointRows.value
  if (!rising?.valid || !falling?.valid || rows.length === 0) return null
  const stages = rows.map((row) => row.rating.stageM)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const hStar = Number(((stageMin + stageMax) / 2).toFixed(2))
  const qr = curveFlow(rising, hStar)
  const qf = curveFlow(falling, hStar)
  const width = Number(Math.abs(qr - qf).toFixed(1))
  const avg = (qr + qf) / 2
  return {
    stageM: hStar,
    risingFlow: qr,
    fallingFlow: qf,
    widthM3s: width,
    widthPct: avg > 0 ? Number(((width / avg) * 100).toFixed(1)) : 0
  }
})

/** 关系曲线坐标：横轴水位、纵轴流量；涨水支 / 落水支各一条曲线 */
const chart = computed(() => {
  const rows = pointRows.value
  if (rows.length === 0) {
    return {
      risingSamples: '',
      fallingSamples: '',
      points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; riseFall: RiseFall }>,
      loop: null as null | {
        x: number
        yTop: number
        yBottom: number
        labelX: number
        labelY: number
        anchor: 'start' | 'end'
        width: string
        hStar: string
      },
      stageMin: 0,
      stageMax: 0,
      flowMax: 0
    }
  }
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const buildSamples = (fit: RatingFitResult | null): string => {
    if (!fit?.valid) return ''
    return Array.from({ length: sampleCount }, (_, index) => {
      const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
      const value = curveFlow(fit, stageM)
      return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
    }).join(' ')
  }
  const rising = risingFit.value
  const falling = fallingFit.value
  let loop = null
  if (rising?.valid && falling?.valid) {
    const hStar = Number(((stageMin + stageMax) / 2).toFixed(2))
    const qr = curveFlow(rising, hStar)
    const qf = curveFlow(falling, hStar)
    const x = toX(hStar)
    const anchor: 'start' | 'end' = x > 285 ? 'end' : 'start'
    loop = {
      x,
      yTop: toY(Math.max(qr, qf)),
      yBottom: toY(Math.min(qr, qf)),
      labelX: anchor === 'end' ? x - 8 : x + 8,
      labelY: (toY(qr) + toY(qf)) / 2,
      anchor,
      width: Math.abs(qr - qf).toFixed(1),
      hStar: hStar.toFixed(2)
    }
  }
  return {
    risingSamples: buildSamples(rising),
    fallingSamples: buildSamples(falling),
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict,
      riseFall: row.rating.riseFall
    })),
    loop,
    stageMin,
    stageMax,
    flowMax
  }
})

/** 表单内水位 / 时间改动后，未手动改定时按相邻测次水位自动刷新涨落标识 */
function refreshSuggestion(): void {
  if (riseFallTouched.value || form.riseFallManual) return
  form.riseFall = suggestRiseFall(ratingStore.ratings, form.stationId, form.stageM, form.measuredAt)
}

/** 定线人员手动改定涨落态势：标记后不再随水位 / 时间变动自动刷新 */
function markRiseFallManual(): void {
  riseFallTouched.value = true
  form.riseFallManual = true
}

watch(() => [form.stageM, form.measuredAt, form.stationId], refreshSuggestion)

function openCreate(): void {
  editingId.value = null
  riseFallTouched.value = false
  form.riseFallManual = false
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = pointRows.value[pointRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  refreshSuggestion()
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  riseFallTouched.value = false
  form.riseFallManual = rating.riseFallManual ?? false
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.riseFall = rating.riseFall
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      riseFall: form.riseFall,
      riseFallManual: form.riseFallManual,
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，正在重算定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo)
  ElMessage.success('点据已删除并重算定线')
}

async function refit(): Promise<void> {
  const count = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  const { rising, falling } = branchFits.value
  const parts: string[] = []
  if (rising?.valid) {
    parts.push(`涨水支 Q=${rising.a}×(H-${rising.h0})^${rising.b}，残差 ${rising.meanResidualPct}%`)
  } else {
    parts.push(`涨水支未定线：${rising?.message ?? '点据不足 3 个'}`)
  }
  if (falling?.valid) {
    parts.push(`落水支 Q=${falling.a}×(H-${falling.h0})^${falling.b}，残差 ${falling.meanResidualPct}%`)
  } else {
    parts.push(`落水支未定线：${falling?.message ?? '点据不足 3 个'}`)
  }
  const loop = loopWidth.value
  const loopText = loop ? `；绳套宽度 ΔQ=${loop.widthM3s} m³/s（H=${loop.stageM} m）` : ''
  if (rising?.valid || falling?.valid) {
    ElMessage.success(`定线完成：${parts.join('；')}${loopText}，刷新比测 ${count} 条`)
  } else {
    ElMessage.warning(parts.join('；'))
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

/** 点据颜色：超限挂红，否则按涨落支配色 */
function pointColor(row: { verdict: string; riseFall: RiseFall }): string {
  if (row.verdict === '超限') return '#c0392b'
  return row.riseFall === 'rising' ? '#e67e22' : '#2980b9'
}

function pointStroke(row: { verdict: string; riseFall: RiseFall }): string {
  if (row.verdict === '超限') return '#7b241c'
  return row.riseFall === 'rising' ? '#b96408' : '#1a5276'
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线</h2>
        <p class="gb-hint">
          点据按定线号分组，并按涨落态势分成涨水支 / 落水支分别幂函数拟合 Q = a×(H-H0)^b；残差超过
          {{ ratingStore.deviationLimitPct }}% 的点据自动挂红并进入比测分析清单，比测曲线流量取所属支线拟合值。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge label="当前线点据" :value="pointRows.length" suffix="点" icon="DataLine" />
      <StatBadge
        label="涨水支"
        :value="risingFit?.valid ? `Q=${risingFit.a}·(H-${risingFit.h0})^${risingFit.b}` : '未定线'"
        :suffix="risingFit?.valid ? `${risingFit.sampleCount} 点` : '不足 3 点'"
        :tone="risingFit?.valid ? 'warning' : 'info'"
        icon="TrendCharts"
      />
      <StatBadge
        label="落水支"
        :value="fallingFit?.valid ? `Q=${fallingFit.a}·(H-${fallingFit.h0})^${fallingFit.b}` : '未定线'"
        :suffix="fallingFit?.valid ? `${fallingFit.sampleCount} 点` : '不足 3 点'"
        :tone="fallingFit?.valid ? 'info' : 'info'"
        icon="TrendCharts"
      />
      <StatBadge
        label="绳套宽度"
        :value="loopWidth ? `ΔQ=${loopWidth.widthM3s}` : '—'"
        :suffix="loopWidth ? `m³/s · ${loopWidth.widthPct}%` : '两支未定线'"
        :tone="loopWidth ? 'success' : 'info'"
        icon="DataLine"
      />
    </div>

    <el-alert
      v-if="pointRows.length === 0"
      type="warning"
      show-icon
      :closable="false"
      title="当前定线号下点据不足，至少需要 3 个实测点才能定线"
    />
    <template v-else>
      <el-alert
        v-if="risingFit && !risingFit.valid"
        type="warning"
        show-icon
        :closable="false"
        :title="`涨水支未定线：${risingFit.message}`"
      />
      <el-alert
        v-if="fallingFit && !fallingFit.valid"
        type="warning"
        show-icon
        :closable="false"
        :title="`落水支未定线：${fallingFit.message}`"
      />
      <el-alert
        v-if="risingFit?.valid && fallingFit?.valid"
        type="success"
        show-icon
        :closable="false"
        :title="`${ratingStore.activeLineNo} 线两支定线有效：涨水支 Q = ${risingFit.a} × (H - ${risingFit.h0})^${risingFit.b}（${risingFit.sampleCount} 点）；落水支 Q = ${fallingFit.a} × (H - ${fallingFit.h0})^${fallingFit.b}（${fallingFit.sampleCount} 点）；同水位绳套宽度 ΔQ = ${loopWidth?.widthM3s} m³/s（H = ${loopWidth?.stageM} m）`"
      />
    </template>

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有关系点据"
        description="录入实测水位与流量点据后即可按涨落支做幂函数定线；也可以先切换到其他定线号查看已有成果。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="涨落" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.rating.riseFall === 'rising' ? 'warning' : 'primary'" effect="plain">
              {{ RISE_FALL_LABELS[row.rating.riseFall as RiseFall] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差" width="200">
          <template #default="{ row }">
            <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="ratingStore.deviationLimitPct" />
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="180">
          <template #default="{ row }">
            <div>{{ row.stationName }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线（涨水支 / 落水支）</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <!-- 涨水支曲线 -->
          <polyline v-if="risingFit?.valid" :points="chart.risingSamples" fill="none" stroke="#e67e22" stroke-width="2" />
          <!-- 落水支曲线 -->
          <polyline v-if="fallingFit?.valid" :points="chart.fallingSamples" fill="none" stroke="#2980b9" stroke-width="2" />
          <!-- 绳套宽度：同一水位两支流量差 -->
          <g v-if="chart.loop">
            <line
              :x1="chart.loop.x"
              :y1="chart.loop.yTop"
              :x2="chart.loop.x"
              :y2="chart.loop.yBottom"
              stroke="#7b241c"
              stroke-width="1.4"
              stroke-dasharray="4 3"
            />
            <line
              :x1="chart.loop.x - 4"
              :y1="chart.loop.yTop"
              :x2="chart.loop.x + 4"
              :y2="chart.loop.yTop"
              stroke="#7b241c"
              stroke-width="1.4"
            />
            <line
              :x1="chart.loop.x - 4"
              :y1="chart.loop.yBottom"
              :x2="chart.loop.x + 4"
              :y2="chart.loop.yBottom"
              stroke="#7b241c"
              stroke-width="1.4"
            />
            <text
              :x="chart.loop.labelX"
              :y="chart.loop.labelY"
              class="gb-chart-loop"
              :text-anchor="chart.loop.anchor"
            >绳套宽度 ΔQ={{ chart.loop.width }} m³/s（H={{ chart.loop.hStar }}）</text>
          </g>
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="pointColor(point)"
            :stroke="pointStroke(point)"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动生成关系曲线。" compact />
        <div class="page__legend">
          <span class="page__legend-item"><i class="page__legend-line" style="background:#e67e22" />涨水支</span>
          <span class="page__legend-item"><i class="page__legend-line" style="background:#2980b9" />落水支</span>
          <span class="page__legend-item"><i class="page__legend-dot" style="background:#c0392b" />超限点据</span>
        </div>
        <p class="gb-hint">同水位下涨水支与落水支的流量差即绳套宽度，按两支曲线拟合值计算；红点表示残差超限的点据。</p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="涨落态势" required>
          <el-radio-group v-model="form.riseFall" @change="markRiseFallManual">
            <el-radio value="rising">涨水</el-radio>
            <el-radio value="falling">落水</el-radio>
          </el-radio-group>
          <span class="gb-hint page__rise-hint">默认按相邻测次水位自动识别，定线人员可改定</span>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并定线' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__line-select {
  width: 120px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.gb-chart-loop {
  font-size: 11px;
  font-weight: 600;
  fill: #7b241c;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 6px 0;
  font-size: 12px;
  color: #5d6d79;
}

.page__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.page__legend-line {
  display: inline-block;
  width: 18px;
  height: 3px;
  border-radius: 2px;
}

.page__legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.page__rise-hint {
  margin-left: 10px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
