import { format } from "date-fns";
import { useHistory } from "@/hooks/use-canonical";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Hash, CalendarClock, FileCode } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { motion } from "framer-motion";

export default function HistoryPage() {
  const { data: history, isLoading, error } = useHistory();

  if (isLoading) {
    return (
      <div className="flex h-[50vh] w-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-8 text-center text-destructive">
        <h3 className="text-lg font-bold">Error loading history</h3>
        <p>{error.message}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8 bg-muted/30">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">Operation History</h2>
          <p className="text-muted-foreground">
            Recent canonicalization requests and their resulting hashes.
          </p>
        </div>

        <Card className="border shadow-sm overflow-hidden">
          <div className="rounded-md border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-[180px]">
                    <div className="flex items-center gap-2">
                      <CalendarClock className="w-4 h-4" />
                      Timestamp
                    </div>
                  </TableHead>
                  <TableHead className="w-[150px]">
                     <div className="flex items-center gap-2">
                      <Hash className="w-4 h-4" />
                      Hash Fragment
                    </div>
                  </TableHead>
                  <TableHead>
                    <div className="flex items-center gap-2">
                      <FileCode className="w-4 h-4" />
                      Original Input Snippet
                    </div>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history && history.length > 0 ? (
                  history.map((item, index) => (
                    <motion.tr
                      key={item.id}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="group hover:bg-muted/40 transition-colors"
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.createdAt ? format(new Date(item.createdAt), "MMM d, HH:mm:ss") : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
                            {item.sha256Hash.substring(0, 8)}...
                          </code>
                          <CopyButton 
                            value={item.sha256Hash} 
                            variant="ghost" 
                            size="icon" 
                            className="h-6 w-6 opacity-0 group-hover:opacity-100" 
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[400px] truncate font-mono text-xs text-muted-foreground">
                          {item.originalInput}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant="secondary" className="font-normal text-xs">
                          Valid
                        </Badge>
                      </TableCell>
                    </motion.tr>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center">
                      No history found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
