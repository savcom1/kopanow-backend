package com.kopanow.contract

import java.text.NumberFormat
import java.util.Locale

/**
 * Full Swahili loan contract body (sections 1–9).
 */
object ContractCopy {

    private fun tzs(n: Long): String =
        NumberFormat.getIntegerInstance(Locale("en", "TZ")).format(n)

    fun buildContractText(
        extras: LoanContractExtras,
        scheduleRows: List<ScheduleRow>,
    ): String = buildString {
        appendLine("NAMBA YA MKATABA: ${extras.contractNumber}")
        appendLine("NAMBA YA MKOPO: ${extras.loanId}")
        appendLine()
        appendLine("(1) WAPATILIANA")
        appendLine()
        appendLine("Mkopeshaji: Elegansky Microfinance Limited (KopaNow), ofisi iliyosajiliwa kisheria Tanzania.")
        appendLine()
        appendLine("Mkopaji (Mteja):")
        appendLine("Jina kamili: ${extras.borrowerName}")
        appendLine("Namba ya mteja: ${extras.borrowerId}")
        appendLine("Simu: ${extras.borrowerPhone}")
        appendLine("Mkoa: ${extras.borrowerRegion}")
        appendLine()
        appendLine("(2) KIASI CHA MKOPO NA MUDA")
        appendLine()
        appendLine("Kiasi cha mkopo (TZS): ${tzs(extras.loanAmountTzs)}")
        appendLine("Jumla ya malipo (TZS): ${tzs(extras.totalRepaymentTzs)}")
        appendLine("Malipo ya kila wiki (TZS): ${tzs(extras.weeklyInstallmentTzs)}")
        appendLine("Idadi ya wiki za malipo: ${extras.numWeeks}")
        appendLine("Tarehe ya kuanza mkopo: ${extras.loanStartDateIso}")
        val firstRepaymentLabel = scheduleRows.firstOrNull()?.dueDateLabel
        appendLine(
            "Tarehe ya malipo ya kwanza: " +
                (firstRepaymentLabel ?: "—"),
        )
        val lastRepaymentLabel = scheduleRows.lastOrNull()?.dueDateLabel
        appendLine(
            "Tarehe ya malipo ya mwisho: " +
                (lastRepaymentLabel ?: "—"),
        )
        appendLine()
        appendLine("(3) RATIBA YA MALIPO")
        appendLine()
        appendLine("Jedwali lifuatalo linaonyesha wiki, tarehe ya malipo, na kiasi cha TZS kwa kila wiki.")
        appendLine()
        appendLine("${"Wiki".padEnd(6)} ${"Tarehe ya malipo".padEnd(18)} Kiasi (TZS)")
        for (r in scheduleRows) {
            appendLine(
                "${r.weekIndex.toString().padEnd(6)} ${r.dueDateLabel.padEnd(18)} ${tzs(r.amountTzs)}"
            )
        }
        appendLine()
        appendLine("(4) DHAMANA")
        appendLine()
        appendLine(
            "Mteja anaweka dhamana simu yake ya Android kama dhamana ya mkopo. Simu hii inaweza " +
                "kufungiwa kidijitali na mfumo wa KopaNow hadi malipo yote yalipwe."
        )
        appendLine()
        appendLine("(5) AKAUNTI YA GOOGLE")
        appendLine()
        appendLine(
            "Kwa muda wa mkopo, mteja anakubali mfumo wa KopaNow kusimamia na kuweka usalama wa simu " +
                "kulingana na sera za kampuni, pamoja na hatua zinazohitajika kwenye akaunti ya Google " +
                "ili kulinda kifaa na malipo."
        )
        appendLine()
        appendLine("(6) RUHUSA ZA PROGRAMU YA KOPANOW")
        appendLine()
        appendLine("Programu inahitaji ruhusa zifuatazo kufanya kazi kwa usahihi:")
        appendLine("• Msimamizi wa kifaa (Device Admin)")
        appendLine("• Huduma ya ufikivu (Accessibility) kwa KopaNow")
        appendLine("• Kuonyesha juu ya programu nyingine (Overlay)")
        appendLine("• Arifa (Notifications)")
        appendLine("• Betri — isizuiliwe (Battery unrestricted)")
        appendLine("• Ufuatiliaji wa matumizi (Usage access)")
        appendLine("• Kengele sahihi (Alarms)")
        appendLine("• Full screen intents")
        appendLine()
        appendLine("(7) MALIPO KUPITIA MIXX NA LIPA NAMBA")
        appendLine()
        appendLine("Malipo yafanyike kupitia Mixx by Yas — Lipa namba: 8681154, jina la kufahamika: ELEGANSKY MICROFINANCE .")
        appendLine("Weka kumbukumbu ya malipo na nambari ya muamala  kwa ajili ya uthibitisho.")
        appendLine()
        appendLine("(8) PENATI")
        appendLine()
        appendLine(
            "Ikiwa malipo hayajafanyika kwa wakati, simu itawekewa lock nakufunguliwa baada ya malipo " +
                "ya ucheleweshaji inaweza kutumika mpaka malipo yote yamalizike, kulingana na sera ya " +
                "kampuni."
        )
        appendLine()
        appendLine("(9) KUKUBALI KI ELEKTRONIKI")
        appendLine()
        appendLine(
            "Kwa kubofya \"NIMEKUBALI\", mteja anathibitisha amesoma, ameelewa, na anakubali masharti " +
                "haya ya mkopo kwa njia ya kielektroniki."
        )
    }
}
