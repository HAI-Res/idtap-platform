<template>
  <div class='main'>
    <div class='bigInfoRow'>
      <div class='bigInfoCol'>
        <select v-model='selectedRaag'>
          <option v-for='(name, i) in raagNames' :key='i'>{{name}}</option>
        </select>
        <input 
          type='text' 
          class='textInput' 
          v-if='selectedRaag === "Other (specify)"'
          v-model='otherRaagName'
          >
      </div>
    </div>
    <div class='infoRow'>
      <div class='sapa'>
        <label for='saToggle' class='small'>Sa</label>
        <input id='saToggle' type='checkbox' v-model='rules.sa'>
      </div>
    </div>
    <div class='infoRow'>
      <div class='sargam'>
        <label class='small'>Re</label>
        <div class='infoCol'>
          <div class='smallInfoRow'>
            <label for='lowReToggle'>Lowered</label>
            <input id='lowReToggle' type='checkbox' v-model='rules.re.lowered'>
          </div>
          <div class='smallInfoRow'>
            <label for='hiReToggle'>Raised</label>
            <input id='hiReToggle' type='checkbox' v-model='rules.re.raised'>
          </div>
        </div>
      </div>
    </div>
    <div class='infoRow'>
      <div class='sargam'>
        <label class='small'>Ga</label>
        <div class='infoCol'>
          <div class='smallInfoRow'>
            <label for='loGaToggle'>Lowered</label>
            <input id='loGaToggle' type='checkbox' v-model='rules.ga.lowered'>
          </div>
          <div class='smallInfoRow'>
            <label for='hiGaToggle'>Raised</label>
            <input id='hiGaToggle' type='checkbox' v-model='rules.ga.raised'>
          </div>
        </div>
      </div>
    </div>
    <div class='infoRow'>
      <div class='sargam'>
        <label class='small'>Ma</label>
        <div class='infoCol'>
          <div class='smallInfoRow'>
            <label for='loMaToggle'>Lowered</label>
            <input id='loMaToggle' type='checkbox' v-model='rules.ma.lowered'>
          </div>
          <div class='smallInfoRow'>
            <label for='hiMaToggle'>Raised</label>
            <input id='hiMaToggle' type='checkbox' v-model='rules.ma.raised'>
          </div>
        </div>
      </div>
    </div>
    <div class='infoRow'>
      <div class='sapa'>
        <label for='paToggle' class='small'>Pa</label>
        <input id='paToggle' type='checkbox' v-model='rules.pa'>
      </div>
    </div>
    <div class='infoRow'>
      <div class='sargam'>
        <label class='small'>Dha</label>
        <div class='infoCol'>
          <div class='smallInfoRow'>
            <label for='loDhaToggle'>Lowered</label>
            <input id='loDhaToggle' type='checkbox' v-model='rules.dha.lowered'>
          </div>
          <div class='smallInfoRow'>
            <label for='hiDhaToggle'>Raised</label>
            <input id='hiDhaToggle' type='checkbox' v-model='rules.dha.raised'>
          </div>
        </div>
      </div>
    </div>
    <div class='infoRow'>
      <div class='sargam'>
        <label class='small'>Ni</label>
        <div class='infoCol'>
          <div class='smallInfoRow'>
            <label for='lowNiToggle'>Lowered</label>
            <input id='lowNiToggle' type='checkbox' v-model='rules.ni.lowered'>
          </div>
          <div class='smallInfoRow'>
            <label for='hiNiToggle'>Raised</label>
            <input id='hiNiToggle' type='checkbox' v-model='rules.ni.raised'>
          </div>
        </div>
      </div>
    </div>
    <div class='infoRow' v-if='selectedRaag !== undefined'>
      <button @click='save' :disabled='pendingOverwrite || !canSave'>save</button>
    </div>
    <div class='infoRow' v-if='selectedRaag !== undefined'>
      <span>{{savedMsg}}</span>
    </div>
    <div class='warning' v-if='pendingOverwrite'>
      <p>
        <strong>“{{ baseName }}” already has saved rules.</strong>
        {{ usageMsg }}
      </p>
      <p>
        Saved transcriptions keep the rule set they were saved with, but
        overwriting changes what “{{ baseName }}” means for every
        <em>new</em> transcription, and for legacy transcriptions that carry
        no rule set of their own. If this is a different form of the raga,
        save it as a variant instead. The variant name must start with
        “{{ baseName }}”.
      </p>
      <div class='variantRow'>
        <input
          type='text'
          class='textInput'
          v-model='variantName'
          @keyup.enter='saveVariant'
          >
        <button :disabled='variantError !== undefined' @click='saveVariant'>
          save as variant
        </button>
      </div>
      <p class='err' v-if='variantError'>{{ variantError }}</p>
      <div class='variantRow'>
        <button class='danger' @click='overwrite'>
          overwrite “{{ baseName }}” anyway
        </button>
        <button @click='pendingOverwrite = false'>cancel</button>
      </div>
    </div>
  </div>
</template>
<script lang='ts'>
 
import {
  getRagaNames,
  getRaagRule,
  getRagaUsage,
  saveRaagRules,
} from '@/js/serverCalls.ts';
import { RuleProfileType } from '@shared/types';
import cloneDeep from 'lodash/cloneDeep';
import isEqual from 'lodash/isEqual';
import { raagLoadState } from '@/js/raagRuleLoad.ts';


type RaagEditorDataType = {
  raagNames: string[],
  selectedRaag: string | undefined,
  otherRaagName: string | undefined,
  rules: RuleProfileType,
  rulesTemplate: RuleProfileType,
  savedMsg: string,
  /** Rules as loaded from the DB for the selected raga; undefined for a new one. */
  loadedRules: RuleProfileType | undefined,
  /** Overwrite warning is showing; save is parked until the user decides. */
  pendingOverwrite: boolean,
  variantName: string,
  usage: { total: number, legacy: number } | undefined,
  /** A rule fetch for the selected raga is in flight. */
  loading: boolean,
  /** The last rule fetch failed; save stays disabled until one succeeds. */
  loadFailed: boolean,
}
export default {
  name: 'RaagEditor',
  
  data(): RaagEditorDataType {
    return {
      raagNames: [],
      selectedRaag: undefined,
      otherRaagName: undefined,
      rules: {
        sa: false,
        re: {
          lowered: false,
          raised: false
        },
        ga: {
          lowered: false,
          raised: false
        },
        ma: {
          lowered: false,
          raised: false
        },
        pa: false,
        dha: {
          lowered: false,
          raised: false
        },
        ni: {
          lowered: false,
          raised: false
        }
      },
      rulesTemplate: {
        sa: false,
        re: {
          lowered: false,
          raised: false
        },
        ga: {
          lowered: false,
          raised: false
        },
        ma: {
          lowered: false,
          raised: false
        },
        pa: false,
        dha: {
          lowered: false,
          raised: false
        },
        ni: {
          lowered: false,
          raised: false
        }
      },
      savedMsg: 'unsaved',
      loadedRules: undefined,
      pendingOverwrite: false,
      variantName: '',
      usage: undefined,
      loading: false,
      loadFailed: false,
    }
  },

  computed: {
    /** The raga name the current edit targets. */
    baseName(): string | undefined {
      return this.selectedRaag === 'Other (specify)' ?
        this.otherRaagName?.trim() :
        this.selectedRaag;
    },
    /** Save only once we know what the DB holds for the selected raga. */
    canSave(): boolean {
      return !this.loading && !this.loadFailed;
    },
    rulesChanged(): boolean {
      return this.loadedRules !== undefined &&
        !isEqual(this.rules, this.loadedRules);
    },
    usageMsg(): string {
      if (!this.usage) return '';
      const { total, legacy } = this.usage;
      const t = `${total} saved transcription${total === 1 ? '' : 's'} use it`;
      if (legacy === 0) return t + '.';
      return `${t}; ${legacy} of them ${legacy === 1 ? 'is' : 'are'} legacy ` +
        '(no rule set of their own) and would load with the new rules.';
    },
    variantError(): string | undefined {
      const base = this.baseName ?? '';
      const v = this.variantName.trim();
      if (v.length === 0) return 'enter a variant name';
      if (!v.startsWith(base)) return `variant name must start with “${base}”`;
      if (v.length === base.length) return `variant name must add something after “${base}”`;
      if (this.raagNames.includes(v)) return `“${v}” already exists — select it from the list to edit it`;
      return undefined;
    },
  },
  
  created() {
    if (this.$store.state.userID === undefined) {
      if (this.$cookies.get('userID') === undefined) {
        this.$router.push('/')
      }     
    }
  },
  
  async mounted() {
    
    this.raagNames = await getRagaNames();
    this.raagNames.push('Other (specify)');
  },
  
  watch: {
    async selectedRaag(newVal) {
      // Reset everything tied to the previous raga BEFORE the await: if the
      // fetch fails, stale rules/loadedRules from raga A must never be
      // saveable under raga B's name, and an open overwrite warning belongs
      // to A.
      this.pendingOverwrite = false;
      this.variantName = '';
      this.usage = undefined;
      this.loadedRules = undefined;
      this.loadFailed = false;
      this.rules = cloneDeep(this.rulesTemplate);
      this.savedMsg = 'loading…';
      this.loading = true;
      let res;
      try {
        res = await getRaagRule(newVal);
      } catch (err) {
        console.error(err);
        res = undefined;
      }
      // A later selection superseded this one; its own watcher run owns state.
      if (this.selectedRaag !== newVal) return;
      const state = raagLoadState(res, this.rulesTemplate);
      this.rules = state.rules;
      this.loadedRules = state.loadedRules;
      this.loadFailed = state.loadFailed;
      this.savedMsg = state.savedMsg;
      this.loading = false;
    }
  },
  
  methods: {
    
    async save() {
      if (!this.canSave) return;
      const name = this.baseName;
      if (!name) {
        this.savedMsg = 'enter a raga name';
        return;
      }
      if (this.selectedRaag === 'Other (specify)' && this.raagNames.includes(name)) {
        this.savedMsg = `“${name}” already exists — select it from the list to edit it`;
        return;
      }
      // Editing an existing raga's rules: park the save behind a warning and
      // offer a variant name instead. Saved transcriptions carry their own
      // ruleSet (PROP-1), but the DB rules define the raga for new pieces and
      // for legacy pieces without one — and the DB's "Yaman" already drifted
      // from every saved Yaman piece this way (2025-10-02).
      if (this.loadedRules !== undefined && this.rulesChanged) {
        const usage = await getRagaUsage(name);
        if (this.baseName !== name) return; // selection changed meanwhile
        this.usage = usage;
        this.variantName = this.suggestVariantName(name);
        this.pendingOverwrite = true;
        return;
      }
      await this.commit(name);
    },

    suggestVariantName(base: string): string {
      let n = 2;
      while (this.raagNames.includes(`${base}_${n}`)) n += 1;
      return `${base}_${n}`;
    },

    async saveVariant() {
      if (this.variantError !== undefined || !this.canSave) return;
      const name = this.variantName.trim();
      const ok = await this.commit(name);
      if (!ok) return;
      this.pendingOverwrite = false;
      // Make the new variant selectable (keep 'Other (specify)' last), and
      // select it so further edits target the variant, not the base raga.
      this.raagNames.splice(this.raagNames.length - 1, 0, name);
      this.selectedRaag = name;
    },

    async overwrite() {
      const name = this.baseName;
      if (!name || !this.canSave) return;
      const ok = await this.commit(name);
      if (ok) this.pendingOverwrite = false;
    },

    /** Write `rules` to the DB under `name`. Returns true on success. */
    async commit(name: string): Promise<boolean> {
      const date = new Date();
      const res = await saveRaagRules(name, this.rules, date);
      if (res) {
        this.savedMsg = 'Saved: ' + date.toLocaleString();
        this.loadedRules = cloneDeep(this.rules);
        return true;
      }
      this.savedMsg = 'save failed';
      return false;
    },
  }
}
</script>

<style scoped>

.bigInfoRow {
  width: 100%;
  height: 80px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.infoRow {
  width: 100%;
  height: 50px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.bigInfoCol {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 250px;
  max-width: 250px;
}

.infoCol {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 150px;
  max-width: 150px;
}

.smallInfoRow {
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: left;
  align-items: center;
}

.sapa {
  width: 200px;
  height: 50px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: left;
}

.sargam {
  width: 200px;
  height: 50px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: left;
}

label {
  width: 70px;
  text-align: right;
  margin-right: 10px;
}

label.small {
  width: 50px;
  min-width: 50px;
  font-weight: bold;
  
}

select {
  width: 250px;
  background-color: var(--Primary);
  color: white;
}

input {
  color: black;
}

button.right {
  margin-left: 10px;
}

.warning {
  width: min(560px, calc(100% - 32px));
  margin: 10px auto;
  padding: 12px 16px;
  border: 1px solid #f0c040;
  border-radius: 6px;
  background-color: rgba(0, 0, 0, 0.35);
  user-select: text;
}

.warning p {
  margin: 6px 0;
  line-height: 1.4;
}

.warning .err {
  color: #ffb3b3;
}

.variantRow {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
}

.variantRow .textInput {
  flex: 1;
  min-width: 0;
}

button.danger {
  border-color: #ff8080;
}

.main {
  background-image: linear-gradient(black, var(--Primary));
  height: 100%;
  color: white;
  user-select: none;
}


</style>
