// يتم قراءة قيمة MAIN_TIKTOK_USERNAME من البيئة
const mainAccount = process.env.MAIN_TIKTOK_USERNAME; // ستصبح "itzsarwar98"

// قيمة الاشتراك المطلوبة
const requiredGiftValue = parseInt(process.env.SUBSCRIPTION_GIFT_VALUE); // ستصبح 500

// في حدث استلام الهدية:
if (data.diamondCount >= requiredGiftValue && streamerUsername === mainAccount) {
    // تفعيل الاشتراك
}
