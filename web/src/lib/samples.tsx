import { Download } from 'lucide-react'
import { downloadCsv } from './report'

/** Ready-made example files (made-up people) so the team can see exactly what each import expects. */
type Kind = 'leads' | 'buyers' | 'zoom' | 'chat' | 'polls' | 'sheet'

const SAMPLES: Record<Kind, { file: string; head: string[]; rows: (string | number)[][]; text?: string }> = {
  leads: { file: 'sample-leads.csv',
    head: ['Name', 'Phone', 'Email', 'City', 'State', 'Profession', 'Company', 'Source', 'Campaign', 'Notes'],
    rows: [['Asha Verma', '9876500011', 'asha.verma@example.com', 'Pune', 'Maharashtra', 'Civil engineer', 'Verma Constructions', 'Facebook Ads', 'October webinar', 'Asked about EMI'],
      ['Rohit Nair', '+91 98765 00022', 'rohit.nair@example.com', 'Kochi', 'Kerala', 'Site supervisor', '', 'Website', '', ''],
      ['Meera Shah', '09876500033', '', 'Ahmedabad', 'Gujarat', 'Architect', 'Studio MS', 'Referral', '', 'Call after 7 PM']] },
  // The owner's buyers master sheet: one row per payment.
  buyers: { file: 'sample-buyers.csv',
    head: ['S. No.', 'Payment Date', 'Webinar Date', 'Program Name', 'Batch No.', 'Name', 'Email ID', 'Contact Number', 'Profession', 'City/Location', 'Country',
      'Direct/Sales Team', 'Team Member Name', 'Amount Paid', 'Price Point', 'Pending Amount', 'Method', 'Part/Full', 'Remark'],
    rows: [[1, '05/10/2026', '04/10/2026', 'Planning Pro Course', 'Batch 12', 'Asha Verma', 'asha.verma@example.com', '9876500011', 'Civil engineer', 'Pune', 'India',
        'Live Webinar Full', '', 29500, 29500, 0, 'Razorpay', 'Full', ''],
      [2, '07/10/2026', '04/10/2026', 'Planning Pro Course', 'Batch 12', 'Rohit Nair', 'rohit.nair@example.com', '9876500022', 'Site supervisor', 'Kochi', 'India',
        'Sales Team Part', 'Priya', 5000, 29500, 24500, 'Personal UPI', 'Part', 'Balance by 15 Oct'],
      [3, '15/10/2026', '04/10/2026', 'Planning Pro Course', 'Batch 12', 'Rohit Nair', 'rohit.nair@example.com', '9876500022', 'Site supervisor', 'Kochi', 'India',
        'Sales Team Part to Full', 'Priya', 24500, 29500, 0, 'Bank', 'Full', ''],
      [4, '09/10/2026', '27/09/2026', 'Planning Pro Course', 'Batch 12', 'Omar Khan', 'omar.khan@example.com', '501234567', 'Project engineer', 'Dubai', 'UAE',
        'Sales Team Full', 'Jaspreet', 29500, 29500, 0, 'Razorpay', 'Full', '']] },
  zoom: { file: 'sample-zoom-attendee-report.csv',
    head: ['Attended', 'User Name (Original Name)', 'Email', 'Phone', 'Join Time', 'Leave Time', 'Time in Session (minutes)'],
    rows: [['Yes', 'Asha Verma', 'asha.verma@example.com', '9876500011', '10/04/2026 19:02:10', '10/04/2026 20:41:00', 99],
      ['Yes', 'Rohit Nair', 'rohit.nair@example.com', '9876500022', '10/04/2026 19:10:00', '10/04/2026 19:35:00', 25],
      ['Yes', 'Rohit Nair', 'rohit.nair@example.com', '9876500022', '10/04/2026 19:50:00', '10/04/2026 20:30:00', 40]] },
  polls: { file: 'sample-zoom-poll-report.csv',
    head: ['#', 'User Name', 'User Email', 'Submitted Date/Time', 'Question', 'Answer'],
    rows: [[1, 'Asha Verma', 'asha.verma@example.com', '10/04/2026 19:25:00', 'How many years of experience do you have?', '2-5 years'],
      [2, 'Asha Verma', 'asha.verma@example.com', '10/04/2026 20:05:00', 'Do you want to join the course?', 'Yes'],
      [3, 'Rohit Nair', 'rohit.nair@example.com', '10/04/2026 19:26:00', 'How many years of experience do you have?', '0-2 years']] },
  chat: { file: 'sample-zoom-chat.txt', head: [], rows: [],
    text: '19:12:05 From Asha Verma to Everyone:\n\tWill we get the recording?\n19:48:40 From Rohit Nair to Everyone:\n\tWhat is the fee? My number is 9876500022\n20:10:12 From Asha Verma to Everyone:\n\tPlease share the payment link\n' },
  sheet: { file: 'sample-registrations-sheet.csv',
    head: ['Date & Time', 'Name', 'Email', 'Phone', 'Profession', 'Experience', 'Ad Source', 'Webinar Date', 'Team Member'],
    rows: [['1/10/2026, 22:48:24', 'Asha Verma', 'asha.verma@example.com', '919876500011', 'Civil engineer', '2-5 Years Of Experience', 'IND', '4th Oct - 2026', 'Jaspreet'],
      ['2/10/2026, 09:15:02', 'Rohit Nair', 'rohit.nair@example.com', '919876500022', 'Site supervisor', '0-2 Years Of Experience', 'IND', '4th Oct - 2026', '']] },
}

export function downloadSample(kind: Kind) {
  const s = SAMPLES[kind]
  if (s.text != null) {
    const url = URL.createObjectURL(new Blob([s.text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = s.file; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } else downloadCsv(s.file, s.head, s.rows)
}

/** "Download a sample file" — next to every import. */
export function SampleLink({ kind, label = 'Download a sample file', className = '' }: { kind: Kind; label?: string; className?: string }) {
  return (
    <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); downloadSample(kind) }}
      className={`inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline ${className}`}>
      <Download className="h-3.5 w-3.5" /> {label}
    </button>
  )
}
