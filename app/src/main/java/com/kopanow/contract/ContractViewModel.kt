package com.kopanow.contract

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kopanow.ContractAcceptanceRequest
import com.kopanow.di.ContractRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ContractViewModel @Inject constructor(
    private val repository: ContractRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ContractSubmitState())
    val uiState: StateFlow<ContractSubmitState> = _uiState.asStateFlow()

    fun submitAcceptance(body: ContractAcceptanceRequest) {
        viewModelScope.launch {
            _uiState.value = ContractSubmitState(isSubmitting = true, error = null, success = false)
            val result = repository.submitContract(body)
            if (result.success && result.data?.success == true) {
                _uiState.value = ContractSubmitState(isSubmitting = false, error = null, success = true)
            } else {
                _uiState.value = ContractSubmitState(
                    isSubmitting = false,
                    error = result.data?.message ?: result.error ?: "Imeshindwa kuhifadhi.",
                    success = false,
                )
            }
        }
    }

    fun consumeSuccess() {
        _uiState.value = _uiState.value.copy(success = false)
    }
}

data class ContractSubmitState(
    val isSubmitting: Boolean = false,
    val error: String? = null,
    val success: Boolean = false,
)
