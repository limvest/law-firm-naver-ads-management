export type Vertical = 'scam' | 'rehab' | 'bankruptcy'
export type FormStep = 'type' | 'amount' | 'contact'

export type FormState = {
  vertical: Vertical
  step: FormStep
  damageType?: string
  amountBand?: string
  submitting: boolean
  done: boolean
  error?: string
}

export type FormAction =
  | { type: 'SELECT_TYPE'; value: string }
  | { type: 'SELECT_AMOUNT'; value: string }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_OK' }
  | { type: 'SUBMIT_FAIL'; error: string }
  | { type: 'BACK' }

export function initialState(vertical: Vertical): FormState {
  return {
    vertical,
    step: vertical === 'scam' ? 'type' : 'amount',
    submitting: false,
    done: false,
  }
}

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SELECT_TYPE':
      return { ...state, damageType: action.value, step: 'amount' }
    case 'SELECT_AMOUNT':
      return { ...state, amountBand: action.value, step: 'contact' }
    case 'SUBMIT_START':
      return { ...state, submitting: true, error: undefined }
    case 'SUBMIT_OK':
      return { ...state, submitting: false, done: true }
    case 'SUBMIT_FAIL':
      return { ...state, submitting: false, error: action.error }
    case 'BACK':
      if (state.step === 'contact') return { ...state, step: 'amount' }
      if (state.step === 'amount' && state.vertical === 'scam') return { ...state, step: 'type' }
      return state
  }
}
