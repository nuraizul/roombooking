# Book rooms from Microsoft Teams with Power Automate (one-time setup)

Staff run one flow from Teams, fill in five details, and the booking appears in RoomFlow. Approval works the same as other bookings.

## Part A: Turn on Teams booking in RoomFlow (admin, 2 minutes)

1. Log in to RoomFlow as Administrator, go to **Settings**.
2. In the **Microsoft Teams booking** panel, turn the switch **ON** and click **Save settings**.
3. Click **Create token**. Copy the token now. It is shown only once.
4. Copy the endpoint shown in the same panel. It looks like:
   `https://YOUR-RAILWAY-URL/api/integrations/teams/booking`

Keep the token private. Anyone with it can create bookings. To stop Teams booking, turn the switch OFF.

## Part B: Create the flow in Power Automate (one time)

Open https://make.powerautomate.com with the Microsoft 365 account that will own the flow.

**Step 1: Create the flow**
1. Click **+ Create** → **Instant cloud flow**.
2. Name it `Book room`. Under *Choose how to trigger this flow*, select **Manually trigger a flow**. Click **Create**.

**Step 2: Add the five inputs**
1. Open the trigger. Click **Add an input** → **Use sample payload to generate schema**.
2. Paste this and click **Done**:
   ```json
   {
     "title": "Team sync",
     "room_no": "101",
     "organizer_email": "name@yourcompany.com",
     "start_at": "2026-11-25T10:00",
     "end_at": "2026-11-25T11:00"
   }
   ```
   This creates five fields that people fill in when they run the flow.

**Step 3: Send the booking to RoomFlow**
1. Click **+ New step**, search for **HTTP**, and select **HTTP**.
   *Note: the HTTP action is a Power Automate premium connector. Check that your account includes it.*
2. Fill it in:
   - **Method**: `POST`
   - **URI**: the endpoint from Part A
   - **Headers**: add two rows
     - `Content-Type` = `application/json`
     - `X-RoomFlow-Token` = the token from Part A
   - **Body**:
     ```json
     {
       "title": "@{triggerBody()?['title']}",
       "room_no": "@{triggerBody()?['room_no']}",
       "organizer_email": "@{triggerBody()?['organizer_email']}",
       "start_at": "@{triggerBody()?['start_at']}",
       "end_at": "@{triggerBody()?['end_at']}"
     }
     ```
3. Click **Save**.

**Step 4: Test it**
1. Click **Test** → **Manually** → **Test**, or run it from the flow page.
2. Fill in the form, for example room `101`, a time later today, and your email.
3. Open RoomFlow → **Bookings**. The booking should be there.
   - If the status is **Pending**, an approver must approve it in RoomFlow.
   - If the run shows an error, open the failed step. A `401` means the token is wrong, `403` means Teams booking is OFF, `404` means the room number does not exist, and `409` means the room is already booked at that time.

## Part C: Use it from Teams (for staff)

1. In Teams, open the **Power Automate** app (add it from *Apps* if it is not there).
2. Open **My flows** → **Book room** → **Run** (or **Run flow**).
3. Fill in the five fields:
   - **title**: the meeting name.
   - **room_no**: the room number exactly as it appears in RoomFlow, for example `101`.
   - **organizer_email**: your work email.
   - **start_at** and **end_at**: local time in this format, `YYYY-MM-DDTHH:MM`, for example `2026-11-25T10:00`.
4. Click **Run flow**.

## Notes
- Use the same email as the RoomFlow user account. Then the booking is linked to that person and follows their role for approval and editing.
- If the email is not a RoomFlow user, the booking still works. It is treated like a Staff booking.
- The flow does not notify the approver. Approvers check the Bookings page in RoomFlow (the **Pending** filter).
- Start and end times must be in the RoomFlow venue time zone.
