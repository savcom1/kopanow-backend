package com.kopanow.di

import com.kopanow.ApiResult
import com.kopanow.ContractAcceptanceRequest
import com.kopanow.ContractAcceptanceResponse
import com.kopanow.KopanowApi
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ContractRepository @Inject constructor() {

    suspend fun submitContract(body: ContractAcceptanceRequest): ApiResult<ContractAcceptanceResponse> =
        KopanowApi.submitContractAcceptance(body)
}
