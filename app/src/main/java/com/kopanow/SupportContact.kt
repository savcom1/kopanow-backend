package com.kopanow

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Kopanow support line — single place for dial URI (E.164) and UI copy. */
object SupportContact {

    fun telUri(context: Context): Uri =
        Uri.parse("tel:${context.getString(R.string.support_phone_tel)}")

    fun dialIntent(context: Context): Intent =
        Intent(Intent.ACTION_DIAL, telUri(context))
}
