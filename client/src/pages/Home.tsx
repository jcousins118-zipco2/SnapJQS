import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useCanonicalize } from "@/hooks/use-canonical";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, ArrowRight, CheckCircle2, FileJson, Hash, RefreshCcw } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";

export default function Home() {
  const [input, setInput] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const { mutate, data: result, isPending, error: apiError, reset } = useCanonicalize();

  const handleProcess = () => {
    setJsonError(null);
    reset();

    if (!input.trim()) return;

    try {
      // First, attempt to parse JSON on client side for immediate feedback
      const parsed = JSON.parse(input);
      mutate(parsed);
    } catch (err) {
      if (err instanceof Error) {
        setJsonError(`Invalid JSON syntax: ${err.message}`);
      } else {
        setJsonError("Invalid JSON syntax");
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      handleProcess();
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] p-4 md:p-8 bg-muted/30">
      <div className="max-w-6xl mx-auto space-y-8">
        
        <div className="space-y-2">
          <h2 className="text-3xl font-bold tracking-tight">JSON Canonicalizer</h2>
          <p className="text-muted-foreground max-w-2xl">
            Deterministically format and hash your JSON data. 
            Ensures identical structures yield identical hashes by sorting keys and removing whitespace.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
          
          {/* LEFT COLUMN - INPUT */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <Card className="p-1 border shadow-sm bg-card/50 backdrop-blur-sm">
              <div className="bg-muted/50 px-4 py-3 border-b flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileJson className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold">Input JSON</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Paste raw JSON below
                </div>
              </div>
              <div className="relative">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder='{ "key": "value", "a": [1, 2, 3] }'
                  className="min-h-[400px] w-full resize-none border-0 bg-transparent p-4 font-mono text-sm leading-relaxed focus-visible:ring-0"
                  spellCheck={false}
                />
                {/* Floating Action Button inside textarea area on mobile, or bottom on desktop */}
              </div>
              <div className="p-4 border-t bg-muted/10 flex justify-between items-center">
                <span className="text-xs text-muted-foreground hidden sm:inline-block">
                  Ctrl + Enter to process
                </span>
                <div className="flex gap-3 ml-auto">
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={() => { setInput(""); reset(); setJsonError(null); }}
                    disabled={!input}
                  >
                    Clear
                  </Button>
                  <Button 
                    onClick={handleProcess}
                    disabled={isPending || !input.trim()}
                    className={cn(
                      "min-w-[120px] transition-all",
                      isPending ? "opacity-80" : "shadow-lg shadow-primary/20"
                    )}
                  >
                    {isPending ? (
                      <>
                        <RefreshCcw className="mr-2 h-4 w-4 animate-spin" />
                        Processing
                      </>
                    ) : (
                      <>
                        Canonicalize
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </Card>

            <AnimatePresence>
              {(jsonError || apiError) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <h4 className="font-semibold text-destructive text-sm">Processing Failed</h4>
                      <p className="text-sm text-destructive/80">
                        {jsonError || apiError?.message}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* RIGHT COLUMN - OUTPUT */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="space-y-6"
          >
            {result ? (
              <div className="space-y-6">
                {/* Hash Result Card */}
                <Card className="overflow-hidden border-primary/20 shadow-md">
                  <div className="bg-primary/5 p-6 space-y-4">
                    <div className="flex items-center gap-2 text-primary font-medium">
                      <Hash className="w-5 h-5" />
                      <h3>SHA-256 Hash</h3>
                    </div>
                    <div className="relative group">
                      <div className="font-mono text-sm md:text-base break-all bg-background border p-4 rounded-lg shadow-sm text-foreground">
                        {result.hash}
                      </div>
                      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <CopyButton value={result.hash} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50/50 w-fit px-3 py-1 rounded-full border border-green-100">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Valid Canonical JSON</span>
                    </div>
                  </div>
                </Card>

                {/* Canonical JSON Output */}
                <Card className="flex flex-col h-full border shadow-sm">
                  <div className="bg-muted/50 px-4 py-3 border-b flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Code2 className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-semibold">Canonical Output</span>
                    </div>
                    <CopyButton value={result.canonical} variant="ghost" size="sm" className="h-8 w-8" />
                  </div>
                  <div className="p-4 bg-muted/10 grow">
                     <pre className="font-mono text-xs sm:text-sm whitespace-pre-wrap break-all text-muted-foreground leading-relaxed">
                        {result.canonical}
                     </pre>
                  </div>
                </Card>
              </div>
            ) : (
              // Empty State
              <div className="h-full min-h-[400px] flex items-center justify-center border-2 border-dashed border-muted-foreground/20 rounded-xl bg-muted/5">
                <div className="text-center space-y-4 p-8">
                  <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto">
                    <RefreshCcw className="w-8 h-8 text-muted-foreground/50" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-lg font-medium text-foreground">Ready to Process</h3>
                    <p className="text-muted-foreground text-sm max-w-xs mx-auto">
                      Enter JSON on the left to generate its deterministic canonical form and hash.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2 mt-4">
                    <Badge variant="outline" className="bg-background">Sorted Keys</Badge>
                    <Badge variant="outline" className="bg-background">No Whitespace</Badge>
                    <Badge variant="outline" className="bg-background">No Floats</Badge>
                  </div>
                </div>
              </div>
            )}
          </motion.div>

        </div>
      </div>
    </div>
  );
}
